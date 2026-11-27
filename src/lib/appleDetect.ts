//! Finds Apple-platform app projects in a workspace (Xcode, SwiftPM, Flutter, React Native, Expo,
//! Tauri, Capacitor, Kotlin Multiplatform, .NET MAUI). Pure logic over a tiny file-system interface,
//! so it runs in Node tests as well as in the app (see appleBuild.ts for the Tauri adapter).

export interface FsLike {
  /** Entries of a workspace-relative directory ("" = root); [] when missing. */
  list(dir: string): Promise<{ name: string; isDir: boolean }[]>;
  /** Text of a workspace-relative file, or null when missing. */
  read(path: string): Promise<string | null>;
}

export type AppleKind = "xcode" | "spm" | "flutter" | "react-native" | "expo" | "tauri" | "capacitor" | "kmp" | "maui";
export type PackageManager = "npm" | "yarn" | "pnpm" | "bun";

export interface AppleProject {
  kind: AppleKind;
  label: string;
  /** Workspace-relative project directory, "/" separated ("" = root). */
  dir: string;
  /** Files that identified it (relative). */
  evidence: string[];
  /** Xcode container used by xcodebuild (relative to the workspace root). */
  container?: { type: "project" | "workspace"; path: string };
  /** Best guess for the scheme / app name. */
  scheme: string;
  schemes: string[];
  platforms: { ios: boolean; macos: boolean };
  packageManager?: PackageManager;
  /** Lock file next to package.json (enables dependency caching). */
  lockfile?: string;
  /** CocoaPods are used (needs `pod install`). */
  pods?: boolean;
  /** Expo: native ios/ folder already generated (bare workflow). */
  hasNative?: boolean;
  /** .NET MAUI project file and target frameworks. */
  dotnet?: { csproj: string; iosTfm?: string; macTfm?: string; version: string };
  /** SwiftPM: no UIKit/SwiftUI/AppKit imports found, so it may build with Swift on Windows/Linux. */
  swiftPortable?: boolean;
  notes: string[];
}

export type BuildOptionId = "simulator" | "macos" | "tests" | "device" | "testflight" | "notarize" | "expo-go" | "eas" | "swift-local";
export interface BuildOption { id: BuildOptionId; label: string; detail: string; needsAccount: boolean }

const SKIP = new Set(["node_modules", ".git", "build", "dist", "Pods", "DerivedData", "target", ".build", ".dart_tool", "bin", "obj", ".expo", ".gradle", "artifacts"]);
const join = (...parts: string[]) => parts.filter(Boolean).join("/");
const stripExt = (n: string) => n.replace(/\.[^.]+$/, "");

async function json(fs: FsLike, path: string): Promise<any | null> {
  const t = await fs.read(path);
  if (t == null) return null;
  try { return JSON.parse(t); } catch { return null; }
}

function packageManager(names: Set<string>): PackageManager {
  if (names.has("pnpm-lock.yaml")) return "pnpm";
  if (names.has("yarn.lock")) return "yarn";
  if (names.has("bun.lockb") || names.has("bun.lock")) return "bun";
  return "npm";
}

/** Shared scheme names of an .xcodeproj (falls back to the project name). */
async function xcodeSchemes(fs: FsLike, projPath: string): Promise<string[]> {
  const list = await fs.list(join(projPath, "xcshareddata", "xcschemes"));
  const names = list.filter((e) => e.name.endsWith(".xcscheme")).map((e) => stripExt(e.name));
  return names.length ? names : [stripExt(projPath.split("/").pop()!)];
}

/** Platforms from SDKROOT / SUPPORTED_PLATFORMS in project.pbxproj (iOS when unknown). */
async function xcodePlatforms(fs: FsLike, projPath: string): Promise<{ ios: boolean; macos: boolean }> {
  const pbx = (await fs.read(join(projPath, "project.pbxproj"))) ?? "";
  const ios = /SDKROOT = iphoneos|SUPPORTED_PLATFORMS = "[^"]*iphone|SUPPORTS_MACCATALYST = YES/.test(pbx);
  const macos = /SDKROOT = macosx|SUPPORTED_PLATFORMS = "[^"]*macosx|SUPPORTS_MACCATALYST = YES/.test(pbx);
  return ios || macos ? { ios, macos } : { ios: true, macos: false };
}

/** The .xcworkspace (preferred, CocoaPods) or .xcodeproj inside `dir`. */
async function xcodeContainer(fs: FsLike, dir: string) {
  const entries = await fs.list(dir);
  const ws = entries.find((e) => e.name.endsWith(".xcworkspace"));
  const proj = entries.find((e) => e.name.endsWith(".xcodeproj"));
  if (!ws && !proj) return null;
  const projPath = proj ? join(dir, proj.name) : null;
  const schemes = projPath ? await xcodeSchemes(fs, projPath) : [stripExt(ws!.name)];
  const container = ws ? { type: "workspace" as const, path: join(dir, ws.name) } : { type: "project" as const, path: projPath! };
  const platforms = projPath ? await xcodePlatforms(fs, projPath) : { ios: true, macos: false };
  return { container, schemes, platforms, projPath };
}

/** Parses `platforms: [.iOS(...), .macOS(...)]` from Package.swift. */
export function swiftPlatforms(pkg: string): { ios: boolean; macos: boolean; declared: boolean } {
  const m = pkg.match(/platforms\s*:\s*\[([\s\S]*?)\]/);
  if (!m) return { ios: false, macos: false, declared: false };
  return { ios: /\.iOS\b/.test(m[1]), macos: /\.macOS\b/.test(m[1]), declared: true };
}

const APPLE_ONLY = /^\s*(?:@\w+\s+)*import\s+(UIKit|SwiftUI|AppKit|Cocoa|WatchKit|Combine|CoreData|MapKit|StoreKit)\b/m;

/** True when none of the first ~40 Swift sources import an Apple-only framework. */
async function swiftPortable(fs: FsLike, dir: string): Promise<boolean> {
  const files: string[] = [];
  const walk = async (d: string, depth: number) => {
    if (depth > 4 || files.length >= 40) return;
    for (const e of await fs.list(d)) {
      if (e.isDir) { if (!SKIP.has(e.name)) await walk(join(d, e.name), depth + 1); }
      else if (e.name.endsWith(".swift")) files.push(join(d, e.name));
    }
  };
  await walk(join(dir, "Sources"), 0);
  for (const f of files.slice(0, 40)) if (APPLE_ONLY.test((await fs.read(f)) ?? "")) return false;
  return true;
}

/** Inspects one directory; returns the projects rooted there and the subdirectories they own. */
async function detectIn(fs: FsLike, dir: string): Promise<{ found: AppleProject[]; claimed: string[] }> {
  const entries = await fs.list(dir);
  const names = new Set(entries.map((e) => e.name));
  const dirs = new Set(entries.filter((e) => e.isDir).map((e) => e.name));
  const found: AppleProject[] = [];
  const claimed: string[] = [];
  const base = (dir.split("/").pop() || "App").replace(/[^\w.-]/g, "") || "App";
  const pkgJson = names.has("package.json") ? await json(fs, join(dir, "package.json")) : null;
  const deps = { ...(pkgJson?.dependencies ?? {}), ...(pkgJson?.devDependencies ?? {}) };
  const pm = packageManager(names);
  const lockfile = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock"].find((n) => names.has(n));

  // Flutter
  if (names.has("pubspec.yaml")) {
    const pub = (await fs.read(join(dir, "pubspec.yaml"))) ?? "";
    if (/^\s*flutter\s*:/m.test(pub) && (dirs.has("ios") || dirs.has("macos"))) {
      const name = pub.match(/^name\s*:\s*([\w-]+)/m)?.[1] ?? base;
      found.push({
        kind: "flutter", label: "Flutter", dir, evidence: [join(dir, "pubspec.yaml"), ...["ios", "macos"].filter((d) => dirs.has(d)).map((d) => join(dir, d) + "/")],
        scheme: "Runner", schemes: ["Runner"], container: dirs.has("ios") ? { type: "workspace", path: join(dir, "ios", "Runner.xcworkspace") } : undefined,
        platforms: { ios: dirs.has("ios"), macos: dirs.has("macos") }, pods: true, notes: [`App name: ${name}`],
      });
      claimed.push("ios", "macos");
    }
  }

  // Expo / React Native
  const appJson = names.has("app.json") ? await json(fs, join(dir, "app.json")) : null;
  const appConfig = [...names].find((n) => /^app\.config\.(js|ts|mjs|cjs|json)$/.test(n));
  const isExpo = !!deps.expo || !!appJson?.expo || (!!appConfig && !!deps.expo);
  if (isExpo || (deps["react-native"] && names.has("ios"))) {
    const ios = await xcodeContainer(fs, join(dir, "ios"));
    const hasPodfile = (await fs.list(join(dir, "ios"))).some((e) => e.name === "Podfile");
    if (isExpo) {
      const name = (appJson?.expo?.name as string | undefined) ?? pkgJson?.name ?? base;
      found.push({
        kind: "expo", label: "Expo", dir, evidence: [join(dir, appJson?.expo ? "app.json" : appConfig ?? "package.json")],
        scheme: ios?.schemes[0] ?? name.replace(/[^\w]/g, ""), schemes: ios?.schemes ?? [], container: ios?.container,
        platforms: { ios: true, macos: false }, packageManager: pm, lockfile, pods: true, hasNative: !!ios,
        notes: ios ? ["Native ios/ folder found (prebuilt or bare workflow)."] : ["Managed workflow: the cloud build runs `expo prebuild` first."],
      });
      claimed.push("ios");
    } else if (hasPodfile && ios) {
      found.push({
        kind: "react-native", label: "React Native", dir, evidence: [join(dir, "ios", "Podfile"), join(dir, "package.json")],
        scheme: ios.schemes[0], schemes: ios.schemes, container: { type: "workspace", path: ios.container.path.replace(/\.xcodeproj$/, ".xcworkspace") },
        platforms: { ios: true, macos: !!deps["react-native-macos"] }, packageManager: pm, lockfile, pods: true, notes: [],
      });
      claimed.push("ios");
    }
  }

  // Capacitor
  const capConfig = [...names].find((n) => /^capacitor\.config\.(ts|js|json)$/.test(n));
  if (capConfig) {
    const app = await xcodeContainer(fs, join(dir, "ios", "App"));
    const podfile = (await fs.list(join(dir, "ios", "App"))).some((e) => e.name === "Podfile");
    found.push({
      kind: "capacitor", label: "Capacitor", dir, evidence: [join(dir, capConfig), ...(app ? [app.container.path] : [])],
      scheme: "App", schemes: ["App"],
      container: podfile ? { type: "workspace", path: join(dir, "ios", "App", "App.xcworkspace") } : app?.container,
      platforms: { ios: true, macos: false }, packageManager: pm, lockfile, pods: podfile,
      notes: app ? [] : ["No ios/ platform yet: run `npx cap add ios` and commit it, or the cloud build adds it."],
    });
    claimed.push("ios");
  }

  // Tauri
  if (dirs.has("src-tauri")) {
    const conf = await json(fs, join(dir, "src-tauri", "tauri.conf.json"));
    if (conf) {
      const hasIos = (await fs.list(join(dir, "src-tauri", "gen", "apple"))).length > 0;
      const name = conf.productName ?? conf.package?.productName ?? pkgJson?.name ?? base;
      found.push({
        kind: "tauri", label: "Tauri", dir, evidence: [join(dir, "src-tauri", "tauri.conf.json")], scheme: name, schemes: [name],
        platforms: { ios: hasIos, macos: true }, packageManager: pm, lockfile,
        notes: hasIos ? ["iOS project found in src-tauri/gen/apple."] : ["iOS needs `tauri ios init` (commit src-tauri/gen/apple) — macOS builds work now."],
      });
    }
  }

  // Kotlin Multiplatform
  if (dirs.has("iosApp")) {
    const app = await xcodeContainer(fs, join(dir, "iosApp"));
    if (app) {
      found.push({
        kind: "kmp", label: "Kotlin Multiplatform", dir, evidence: [app.container.path], container: app.container,
        scheme: app.schemes[0], schemes: app.schemes, platforms: { ios: true, macos: false }, notes: [],
      });
      claimed.push("iosApp");
    }
  }

  // .NET MAUI
  for (const e of entries) {
    if (e.isDir || !e.name.endsWith(".csproj")) continue;
    const proj = (await fs.read(join(dir, e.name))) ?? "";
    const tfms = proj.match(/<TargetFrameworks?>([^<]*)<\/TargetFrameworks?>/g)?.join(";") ?? "";
    const iosTfm = tfms.match(/net\d+\.\d+-ios[\d.]*/)?.[0];
    const macTfm = tfms.match(/net\d+\.\d+-(?:maccatalyst|macos)[\d.]*/)?.[0];
    if (!iosTfm && !macTfm) continue;
    found.push({
      kind: "maui", label: /<UseMaui>true/i.test(proj) ? ".NET MAUI" : ".NET for iOS", dir, evidence: [join(dir, e.name)],
      scheme: stripExt(e.name), schemes: [stripExt(e.name)], platforms: { ios: !!iosTfm, macos: !!macTfm },
      dotnet: { csproj: join(dir, e.name), iosTfm, macTfm, version: ((iosTfm ?? macTfm)!.match(/net(\d+)/)?.[1] ?? "8") + ".0.x" }, notes: [],
    });
    break;
  }

  // Swift package
  if (names.has("Package.swift")) {
    const pkg = (await fs.read(join(dir, "Package.swift"))) ?? "";
    const p = swiftPlatforms(pkg);
    const name = pkg.match(/Package\s*\(\s*name\s*:\s*"([^"]+)"/)?.[1] ?? base;
    found.push({
      kind: "spm", label: "Swift package", dir, evidence: [join(dir, "Package.swift")], scheme: name, schemes: [name],
      platforms: p.declared ? { ios: p.ios, macos: p.macos } : { ios: false, macos: true }, swiftPortable: await swiftPortable(fs, dir),
      notes: p.declared ? [] : ["No `platforms:` declared: built and tested as a macOS package."],
    });
  }

  // Plain Xcode project/workspace (not one generated by a framework above)
  if (!found.some((f) => f.kind !== "spm")) {
    const x = await xcodeContainer(fs, dir);
    if (x) {
      found.push({
        kind: "xcode", label: "Xcode", dir, evidence: [x.container.path], container: x.container, scheme: x.schemes[0], schemes: x.schemes,
        platforms: x.platforms, pods: names.has("Podfile"), notes: [],
      });
    }
  }
  return { found, claimed };
}

/** Scans the workspace root and its immediate subfolders (monorepos: apps/mobile, etc. two levels). */
export async function detectAppleProjects(fs: FsLike): Promise<AppleProject[]> {
  const out: AppleProject[] = [];
  const visit = async (dir: string, depth: number) => {
    const { found, claimed } = await detectIn(fs, dir);
    out.push(...found);
    if (depth >= 2) return;
    for (const e of await fs.list(dir)) {
      if (!e.isDir || SKIP.has(e.name) || e.name.startsWith(".") || claimed.includes(e.name)) continue;
      if (/\.(xcodeproj|xcworkspace|xcassets|app|framework)$/.test(e.name)) continue;
      // Framework-owned native folders (ios/, macos/, src-tauri/) are never separate projects.
      if (found.length && ["ios", "macos", "android", "src-tauri", "iosApp"].includes(e.name)) continue;
      await visit(join(dir, e.name), depth + 1);
    }
  };
  await visit("", 0);
  return out;
}

/** What can be built for a project, with honest requirements. */
export function buildOptions(p: AppleProject): BuildOption[] {
  const o: BuildOption[] = [];
  const add = (id: BuildOptionId, label: string, detail: string, needsAccount = false) => o.push({ id, label, detail, needsAccount });
  if (p.kind === "expo") {
    add("expo-go", "Preview on iPhone with Expo Go", "Runs `npx expo start --tunnel` here and shows a QR code for the free Expo Go app. No Mac needed.");
    add("eas", "Build with EAS", "Runs `npx eas-cli build --platform ios` — Expo's cloud build. Needs an Expo account; device/App Store builds also need an Apple Developer account.", true);
  }
  if (p.kind === "spm" && p.swiftPortable) add("swift-local", "Build & test Swift package locally", "Uses `swift build` / `swift test` if Swift for Windows/Linux is installed. Apple-only frameworks (UIKit, SwiftUI, AppKit) still need the cloud build.");
  if (p.platforms.ios && p.kind !== "spm") add("simulator", "iOS Simulator build", "Unsigned .app for the iOS Simulator, zipped. No Apple account needed.");
  if (p.platforms.ios && p.kind === "spm") add("simulator", "Build for iOS Simulator", "Compiles the package for the iOS Simulator (libraries produce no .app).");
  if (p.platforms.macos) add("macos", "macOS app (unsigned)", p.kind === "spm" ? "Builds the package on macOS." : "Unsigned (ad-hoc) .app and .dmg. Other Macs show a Gatekeeper warning until it is signed and notarized.");
  if (p.kind !== "maui") add("tests", "Run tests", testLabel(p));
  if (p.platforms.ios && p.kind !== "spm" && p.kind !== "maui" && p.kind !== "tauri") {
    add("device", "Signed iOS archive (.ipa)", "Needs an Apple Developer Program membership, a distribution certificate and a provisioning profile stored as GitHub secrets.", true);
    add("testflight", "Upload to TestFlight", "Uses an App Store Connect API key (GitHub secrets) and `xcrun altool`. Needs an Apple Developer Program membership.", true);
  }
  if (p.platforms.macos && p.kind !== "spm") add("notarize", "Signed + notarized macOS build", "Needs a Developer ID Application certificate and an App Store Connect API key as GitHub secrets.", true);
  return o;
}

export function testLabel(p: AppleProject): string {
  switch (p.kind) {
    case "flutter": return "`flutter test` on the macOS runner.";
    case "spm": return "`swift test` on the macOS runner.";
    case "expo": case "react-native": case "capacitor": return "Your package.json `test` script (if any).";
    case "tauri": return "`cargo test` for src-tauri.";
    case "kmp": return "`./gradlew allTests` (includes iOS simulator tests).";
    default: return "`xcodebuild test` on an iOS Simulator (or macOS for Mac apps).";
  }
}
