//! Generates `.github/workflows/cepheus-apple.yml` for a detected Apple project. Pure string
//! building (templates are passed in), so Node tests can snapshot and parse the output.

import type { AppleProject } from "./appleDetect";

export const WORKFLOW_FILE = "cepheus-apple.yml";
export const WORKFLOW_PATH = ".github/workflows/cepheus-apple.yml";

export interface Templates { workflow: string; signing: string; profile: string; testflight: string; notarize: string }

export interface WorkflowOptions {
  /** setup-xcode version: "latest-stable", "16.2", ... */
  xcode: string;
  scheme: string;
  configuration: "Debug" | "Release";
  simulator: boolean;
  macos: boolean;
  tests: boolean;
  device: boolean;
  testflight: boolean;
  notarize: boolean;
  /** Also run (simulator/macOS build + tests) on pushes to this branch; "" = manual only. */
  pushBranch: string;
}

export type BuildTarget = "simulator" | "device" | "macos";

/** Reasonable defaults for a project. */
export function defaultOptions(p: AppleProject): WorkflowOptions {
  return {
    xcode: "latest-stable",
    scheme: p.kind === "expo" && !p.hasNative ? "auto" : p.scheme,
    configuration: "Debug",
    simulator: p.platforms.ios,
    macos: p.platforms.macos,
    tests: p.kind !== "maui",
    device: false,
    testflight: false,
    notarize: false,
    pushBranch: "",
  };
}

/** Which targets the options enable (and that the project supports). */
export function enabledTargets(p: AppleProject, o: WorkflowOptions): BuildTarget[] {
  const r = recipe(p);
  const t: BuildTarget[] = [];
  if (o.simulator && r.simulator) t.push("simulator");
  if (o.device && r.device) t.push("device");
  if (o.macos && r.macos) t.push("macos");
  return t;
}

// ---------- YAML helpers ----------

const yq = (s: string) => JSON.stringify(s);
const exprLit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const indent = (text: string, n: number) => text.split("\n").map((l) => (l ? " ".repeat(n) + l : l)).join("\n");

function fill(tpl: string, vars: Record<string, string>): string {
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) out = out.split(`%%${k}%%`).join(v);
  return out;
}

interface StepOpts { if?: string; dir?: string; env?: Record<string, string>; shell?: string }

/** A `run:` step at steps indentation (6 spaces). */
function run(name: string, script: string, o: StepOpts = {}): string {
  const lines = [`      - name: ${name}`];
  if (o.if) lines.push(`        if: ${o.if}`);
  if (o.dir && o.dir !== ".") lines.push(`        working-directory: ${yq(o.dir)}`);
  if (o.env) {
    lines.push("        env:");
    for (const [k, v] of Object.entries(o.env)) lines.push(`          ${k}: ${v}`);
  }
  lines.push("        run: |");
  lines.push(indent(script.trim(), 10));
  return lines.join("\n");
}

/** A `uses:` step. */
function uses(action: string, withArgs?: Record<string, string>, name?: string, cond?: string): string {
  const lines = [name ? `      - name: ${name}` : `      - uses: ${action}`];
  if (name) lines.push(`        uses: ${action}`);
  if (cond) lines.push(`        if: ${cond}`);
  if (withArgs) {
    lines.push("        with:");
    for (const [k, v] of Object.entries(withArgs)) lines.push(`          ${k}: ${v}`);
  }
  return lines.join("\n");
}

/** Adds an `if:` to the first step of a template fragment. */
function withIf(fragment: string, cond: string): string {
  return fragment.replace(/^( {6}- name: [^\n]*\n)/, `$1        if: ${cond}\n`);
}

// ---------- per-framework recipes ----------

interface Recipe {
  setup: string[];
  /** Scripts run at the repository root unless `dir` says otherwise; they write results to $OUT. */
  simulator?: string;
  macos?: string;
  /** macOS output is a .app bundle that gets zipped + packed into a .dmg. */
  macosApp?: boolean;
  test?: string;
  device?: string;
  /** Working directory of build scripts (xcodebuild runs at the repo root, container paths are root-relative). */
  buildDir: string;
  testDir: string;
  /** Tests that need no Xcode run on a Linux runner with only these setup steps (cheaper than macOS minutes). */
  linuxTestSetup?: string[];
}

const PICK_SIM = `UDID="$(xcrun simctl list devices available -j | python3 -c "import json,sys; d=json.load(sys.stdin)['devices']; print(next(x['udid'] for k in sorted(d, reverse=True) if 'iOS' in k for x in d[k] if x['name'].startswith('iPhone')))")"`;

const FIND_SIM_APP = `APP="$(find build/dd/Build/Products -maxdepth 2 -type d -name '*.app' -path '*iphonesimulator*' | head -1)"
test -n "$APP" || { echo "::error::No .app was produced"; exit 1; }
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT/$(basename "$APP" .app)-simulator.zip"`;

/** Shell prelude that resolves the Xcode container flag and `SCHEME=auto`. */
function xcodePrelude(p: AppleProject): string {
  const c = p.container;
  const find = c
    ? `FLAG=(-${c.type} ${yq(c.path)})`
    : `WS="$(ls -d "$PROJECT_DIR"/ios/*.xcworkspace 2>/dev/null | head -1)"
if [ -n "$WS" ]; then FLAG=(-workspace "$WS"); else FLAG=(-project "$(ls -d "$PROJECT_DIR"/ios/*.xcodeproj | head -1)"); fi`;
  return `set -eo pipefail
${find}
if [ "$SCHEME" = "auto" ]; then SCHEME="$(basename "\${FLAG[1]}" | sed -E 's/\\.(xcworkspace|xcodeproj)$//')"; fi
XC=(xcodebuild "\${FLAG[@]}" -scheme "$SCHEME" -derivedDataPath build/dd -clonedSourcePackagesDirPath build/spm)
mkdir -p "$OUT"`;
}

function xcodeScripts(p: AppleProject) {
  const pre = xcodePrelude(p);
  return {
    simulator: `${pre}
"\${XC[@]}" -configuration "$CONFIGURATION" -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
${FIND_SIM_APP}`,
    macos: `${pre}
"\${XC[@]}" -configuration "$CONFIGURATION" -destination 'generic/platform=macOS' CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO build
APP="$(find "build/dd/Build/Products/$CONFIGURATION" -maxdepth 1 -type d -name '*.app' | head -1)"
test -n "$APP" || { echo "::error::No .app was produced"; exit 1; }
cp -R "$APP" "$OUT/"`,
    test: p.platforms.ios
      ? `${pre}
${PICK_SIM}
"\${XC[@]}" -configuration Debug -destination "id=$UDID" CODE_SIGNING_ALLOWED=NO test`
      : `${pre}
"\${XC[@]}" -configuration Debug -destination 'platform=macOS' CODE_SIGN_IDENTITY=- test`,
    device: `${pre}
"\${XC[@]}" -configuration Release -sdk iphoneos -destination 'generic/platform=iOS' -archivePath build/App.xcarchive archive
xcodebuild -exportArchive -archivePath build/App.xcarchive -exportOptionsPlist "$EXPORT_OPTIONS" -exportPath "$OUT"`,
  };
}

function nodeSetup(p: AppleProject): string[] {
  const pm = p.packageManager ?? "npm";
  const steps: string[] = [];
  if (pm === "bun") steps.push(uses("oven-sh/setup-bun@v2"));
  else {
    const w: Record<string, string> = { "node-version": "lts/*" };
    if (p.lockfile && (pm === "npm" || pm === "yarn")) {
      w.cache = pm;
      w["cache-dependency-path"] = yq(p.dir ? `${p.dir}/${p.lockfile}` : p.lockfile);
    }
    steps.push(uses("actions/setup-node@v4", w));
  }
  const install = {
    npm: p.lockfile === "package-lock.json" ? "npm ci" : "npm install",
    yarn: "corepack enable\nyarn install",
    pnpm: "corepack enable\npnpm install --frozen-lockfile",
    bun: "bun install",
  }[pm];
  steps.push(run("Install JavaScript dependencies", install, { dir: p.dir || "." }));
  return steps;
}

const cache = (name: string, path: string, key: string) =>
  uses("actions/cache@v4", { path: yq(path), key: `${name}-\${{ runner.os }}-${key}`, "restore-keys": `${name}-\${{ runner.os }}-` }, `Cache ${name}`);

const spmCache = () => cache("spm", "build/spm", "${{ hashFiles('**/Package.resolved') }}");
const podsCache = (iosDir: string) => cache("pods", `${iosDir}/Pods`, `\${{ hashFiles('${iosDir}/Podfile.lock') }}`);

export function recipe(p: AppleProject): Recipe {
  const dir = p.dir || ".";
  const at = (rel: string) => (p.dir ? `${p.dir}/${rel}` : rel);
  const x = xcodeScripts(p);
  switch (p.kind) {
    case "xcode": {
      const setup = [spmCache()];
      if (p.pods) setup.push(podsCache(dir), run("Install CocoaPods", "pod install", { dir }));
      return { buildDir: ".", testDir: ".", setup, simulator: p.platforms.ios ? x.simulator : undefined, macos: p.platforms.macos ? x.macos : undefined, macosApp: true, test: x.test, device: p.platforms.ios ? x.device : undefined };
    }
    case "react-native":
    case "expo":
    case "capacitor": {
      const setup = [...nodeSetup(p)];
      if (p.kind === "expo" && !p.hasNative) setup.push(run("Generate the native iOS project", "npx expo prebuild --platform ios --no-install", { dir, env: { CI: "1" } }));
      if (p.kind === "capacitor") {
        setup.push(run("Build web assets and sync iOS", "npm run build --if-present\n[ -d ios ] || npx cap add ios\nnpx cap sync ios", { dir }));
      } else {
        setup.push(podsCache(at("ios")), run("Install CocoaPods", "pod install", { dir: at("ios") }));
      }
      setup.unshift(spmCache());
      return { buildDir: ".", testDir: dir, setup, simulator: x.simulator, test: "npm test --if-present", device: x.device, linuxTestSetup: nodeSetup(p) };
    }
    case "kmp":
      return {
        buildDir: ".", testDir: dir,
        setup: [uses("actions/setup-java@v4", { distribution: "temurin", "java-version": "17" }), uses("gradle/actions/setup-gradle@v4"), spmCache()],
        simulator: x.simulator, device: x.device,
        test: "chmod +x ./gradlew\n./gradlew allTests",
      };
    case "flutter": {
      const flutter = [
        uses("subosito/flutter-action@v2", { channel: "stable", cache: "true" }),
        run("Get Flutter packages", "flutter pub get", { dir }),
      ];
      const setup = p.platforms.ios ? [...flutter, podsCache(at("ios"))] : flutter;
      return {
        buildDir: dir, testDir: dir, setup, macosApp: true, linuxTestSetup: flutter,
        simulator: p.platforms.ios ? `set -eo pipefail
mkdir -p "$OUT"
flutter build ios --simulator --debug
APP="$(find build/ios/iphonesimulator -maxdepth 1 -name '*.app' | head -1)"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT/$(basename "$APP" .app)-simulator.zip"` : undefined,
        macos: p.platforms.macos ? `set -eo pipefail
mkdir -p "$OUT"
MODE="$(echo "$CONFIGURATION" | tr '[:upper:]' '[:lower:]')"
flutter build macos --$MODE
cp -R "$(find "build/macos/Build/Products/$CONFIGURATION" -maxdepth 1 -name '*.app' | head -1)" "$OUT/"` : undefined,
        test: "flutter test",
        device: p.platforms.ios ? `set -eo pipefail
mkdir -p "$OUT"
flutter build ipa --release --export-options-plist="$EXPORT_OPTIONS"
cp build/ios/ipa/*.ipa "$OUT/"` : undefined,
      };
    }
    case "tauri": {
      const setup = [...nodeSetup(p)];
      setup.push(uses("dtolnay/rust-toolchain@stable", p.platforms.ios ? { targets: "aarch64-apple-ios,aarch64-apple-ios-sim" } : undefined));
      setup.push(uses("Swatinem/rust-cache@v2", { workspaces: yq(`${at("src-tauri")} -> target`) }));
      return {
        buildDir: dir, testDir: dir, setup, macosApp: true,
        macos: `set -eo pipefail
mkdir -p "$OUT"
if [ "$CONFIGURATION" = "Debug" ]; then npx tauri build --debug --bundles app; KIND=debug; else npx tauri build --bundles app; KIND=release; fi
cp -R src-tauri/target/$KIND/bundle/macos/*.app "$OUT/"`,
        // Tauri's iOS support builds through its own CLI; simulator output location may vary by version.
        simulator: p.platforms.ios ? `set -eo pipefail
mkdir -p "$OUT"
npx tauri ios build --debug --target aarch64-sim
APP="$(find src-tauri/gen/apple/build -type d -name '*.app' | head -1)"
test -n "$APP" || { echo "::error::No .app was produced"; exit 1; }
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT/$(basename "$APP" .app)-simulator.zip"` : undefined,
        test: "npm run build --if-present\ncargo test --manifest-path src-tauri/Cargo.toml",
      };
    }
    case "maui": {
      const d = p.dotnet!;
      const workloads = p.label === ".NET MAUI" ? "maui" : [d.iosTfm ? "ios" : "", d.macTfm?.includes("maccatalyst") ? "maccatalyst" : d.macTfm ? "macos" : ""].filter(Boolean).join(" ");
      const proj = yq(d.csproj);
      return {
        buildDir: ".", testDir: ".",
        setup: [
          uses("actions/setup-dotnet@v4", { "dotnet-version": yq(d.version) }),
          cache("nuget", "~/.nuget/packages", "${{ hashFiles('**/*.csproj') }}"),
          run("Install .NET workloads", `dotnet workload install ${workloads}`),
        ],
        macosApp: true,
        simulator: d.iosTfm ? `set -eo pipefail
mkdir -p "$OUT"
dotnet build ${proj} -f ${d.iosTfm} -c "$CONFIGURATION" -p:RuntimeIdentifier=iossimulator-arm64
APP="$(find . -type d -name '*.app' -path '*iossimulator-arm64*' -not -path '*/obj/*' | head -1)"
test -n "$APP" || { echo "::error::No .app was produced"; exit 1; }
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT/$(basename "$APP" .app)-simulator.zip"` : undefined,
        macos: d.macTfm ? `set -eo pipefail
mkdir -p "$OUT"
dotnet build ${proj} -f ${d.macTfm} -c "$CONFIGURATION"
APP="$(find . -type d -name '*.app' -path '*/bin/*' -not -path '*.app/*' | grep -v iossimulator | head -1)"
test -n "$APP" || { echo "::error::No .app was produced"; exit 1; }
cp -R "$APP" "$OUT/"` : undefined,
      };
    }
    case "spm":
      return {
        buildDir: dir, testDir: dir, setup: [cache("swiftpm", at(".build"), `\${{ hashFiles('${at("Package.resolved")}') }}`)],
        simulator: p.platforms.ios ? `set -eo pipefail
S="$SCHEME"
if xcodebuild -list | grep -q "^ *$SCHEME-Package$"; then S="$SCHEME-Package"; fi
xcodebuild -scheme "$S" -destination 'generic/platform=iOS Simulator' build` : undefined,
        macos: `swift build -c "$(echo "$CONFIGURATION" | tr '[:upper:]' '[:lower:]')"`,
        macosApp: false,
        test: "swift test",
      };
  }
}

// ---------- jobs ----------

function job(id: string, name: string, cond: string, steps: string[], env?: Record<string, string>, runsOn = "macos-latest"): string {
  const head = [`  ${id}:`, `    name: ${name}`, `    if: ${cond}`, `    runs-on: ${runsOn}`, "    timeout-minutes: 90"];
  if (env) {
    head.push("    env:");
    for (const [k, v] of Object.entries(env)) head.push(`      ${k}: ${v}`);
  }
  head.push("    steps:");
  return [...head, ...steps].join("\n");
}

const upload = (name: string, path = "out/", cond?: string) =>
  uses("actions/upload-artifact@v4", { name, path, "if-no-files-found": "error", "retention-days": "14" }, `Upload ${name}`, cond);

/** Steps the selected options need, before the build itself. */
function prelude(r: Recipe): string[] {
  return [
    uses("actions/checkout@v4"),
    uses("maxim-lobanov/setup-xcode@v1", { "xcode-version": "${{ env.XCODE_VERSION }}" }, "Select Xcode"),
    ...r.setup,
  ];
}

const sigTpl = (t: Templates, kind: string, p12: string, pass: string, match: string) =>
  fill(t.signing, { CERT_KIND: kind, P12_SECRET: p12, P12_PASSWORD_SECRET: pass, IDENTITY_MATCH: match }).trimEnd();

export function generateWorkflow(p: AppleProject, o: WorkflowOptions, t: Templates): string {
  const r = recipe(p);
  const targets = enabledTargets(p, o);
  const runTests = o.tests && !!r.test;
  const defaultTarget = targets[0] ?? "simulator";
  const target = (name: BuildTarget) => `(inputs.target || '${defaultTarget}') == '${name}'`;
  const env = { OUT: "${{ github.workspace }}/out" };
  const jobs: string[] = [];

  if (targets.includes("simulator")) {
    jobs.push(job("simulator", "iOS Simulator build", target("simulator"), [
      ...prelude(r),
      run("Build for iOS Simulator", r.simulator!, { dir: r.buildDir }),
      ...(p.kind === "spm" ? [] : [upload("ios-simulator-app")]),
    ], env));
  }

  if (targets.includes("macos")) {
    const steps = [...prelude(r), run("Build macOS app", r.macos!, { dir: r.buildDir })];
    if (r.macosApp) {
      if (o.notarize) {
        const has = "env.HAS_MAC_CERT == 'true'";
        steps.push(withIf(sigTpl(t, "Developer ID", "MACOS_CERT_P12_BASE64", "MACOS_CERT_PASSWORD", "Developer ID Application"), has));
        steps.push(withIf(t.notarize.trimEnd(), has));
        steps.push(run("Notarization skipped", `echo "::notice::MACOS_CERT_P12_BASE64 is not set, so this build is unsigned. Add the secrets to sign and notarize it."`, { if: "env.HAS_MAC_CERT != 'true'" }));
      }
      steps.push(run("Package .app and .dmg", `set -eo pipefail
cd out
for APP in *.app; do
  NAME="\${APP%.app}"
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$NAME-macos.zip"
  [ -f "$NAME.dmg" ] || hdiutil create -volname "$NAME" -srcfolder "$APP" -ov -format UDZO "$NAME.dmg"
  rm -rf "$APP"
done`));
      steps.push(upload("macos-app"));
    }
    jobs.push(job("macos", o.notarize ? "macOS build (notarized when secrets are set)" : "macOS build (unsigned)", target("macos"), steps,
      o.notarize ? { ...env, HAS_MAC_CERT: "${{ secrets.MACOS_CERT_P12_BASE64 != '' }}" } : env));
  }

  if (runTests) {
    const cond = "github.event_name != 'workflow_dispatch' || inputs.tests";
    const testStep = run("Run tests", r.test!, { dir: r.testDir });
    jobs.push(r.linuxTestSetup
      ? job("test", "Tests (Linux runner)", cond, [uses("actions/checkout@v4"), ...r.linuxTestSetup, testStep], undefined, "ubuntu-latest")
      : job("test", "Tests", cond, [...prelude(r), testStep], env));
  }

  if (targets.includes("device")) {
    const steps = [
      ...prelude(r),
      sigTpl(t, "Apple Distribution", "APPLE_CERT_P12_BASE64", "APPLE_CERT_PASSWORD", "Apple Distribution"),
      t.profile.trimEnd(),
      run("Archive and export signed .ipa", r.device!, { dir: r.buildDir }),
      upload("ios-ipa"),
    ];
    if (o.testflight) steps.push(t.testflight.trimEnd());
    jobs.push(job("device", "Signed iOS archive (.ipa)", target("device"), steps, env));
  }

  const extra: string[] = [];
  if (runTests) extra.push("      tests:", "        description: Run tests", "        type: boolean", "        default: true");
  if (targets.includes("device") && o.testflight)
    extra.push("      testflight:", "        description: Upload the signed iOS build to TestFlight (target device only)", "        type: boolean", "        default: false");

  const push = o.pushBranch ? `  push:\n    branches: [${yq(o.pushBranch)}]\n` : "";
  return fill(t.workflow, {
    LABEL: p.label,
    SCHEME_YAML: yq(o.scheme),
    SCHEME_EXPR: exprLit(o.scheme),
    CONFIGURATION: o.configuration,
    TARGETS: (targets.length ? targets : ["simulator"]).join(", "),
    DEFAULT_TARGET: defaultTarget,
    EXTRA_INPUTS: extra.length ? extra.join("\n") + "\n" : "",
    PUSH: push,
    XCODE: yq(o.xcode),
    PROJECT_DIR: yq(p.dir || "."),
    JOBS: jobs.join("\n\n"),
  }).replace(/\n{3,}/g, "\n\n");
}

// ---------- secrets checklist ----------

export interface SecretInfo { name: string; what: string; how: string }

export function requiredSecrets(o: WorkflowOptions): SecretInfo[] {
  const s: SecretInfo[] = [];
  if (o.device) {
    s.push(
      { name: "APPLE_CERT_P12_BASE64", what: "Your Apple Distribution certificate and its private key, as a .p12 file, base64-encoded.", how: "p12" },
      { name: "APPLE_CERT_PASSWORD", what: "The password you chose when exporting the .p12.", how: "" },
      { name: "APPLE_PROVISIONING_PROFILE_BASE64", what: "An App Store provisioning profile for the app's bundle ID (developer.apple.com › Profiles), base64-encoded.", how: "b64" },
    );
  }
  if (o.notarize) {
    s.push(
      { name: "MACOS_CERT_P12_BASE64", what: "A Developer ID Application certificate and private key (.p12), base64-encoded.", how: "p12" },
      { name: "MACOS_CERT_PASSWORD", what: "The password of that .p12.", how: "" },
    );
  }
  if ((o.device && o.testflight) || o.notarize) {
    s.push(
      { name: "ASC_KEY_ID", what: "App Store Connect API key ID (App Store Connect › Users and Access › Integrations).", how: "" },
      { name: "ASC_ISSUER_ID", what: "The issuer ID shown above the list of API keys.", how: "" },
      { name: "ASC_KEY_P8", what: "The full text of the downloaded AuthKey_XXXX.p8 file (it can be downloaded only once).", how: "" },
    );
  }
  return s;
}
