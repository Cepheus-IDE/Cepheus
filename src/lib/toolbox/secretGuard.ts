//! Commit-time secret guard. The Git panel calls `guardCommit` right before `git commit`; when the
//! staged diff looks like it contains secrets (or a .env file), the commit is held and an inline
//! warning (SecretGuardBanner) offers "Commit anyway", which re-runs the commit once unguarded.

import { gitx } from "../gitApi";
import { scanDiff } from "./secretScan";
import { useToolbox } from "./state";

// "Commit anyway" lets exactly the next attempt through, and only shortly after the click.
let bypassUntil = 0;

/**
 * Returns true when the commit may proceed. Otherwise records the findings for the banner and
 * returns false; `proceed` is what "Commit anyway" runs (normally the same commit function).
 * A failing scan never blocks a commit.
 */
export async function guardCommit(root: string, proceed: () => void): Promise<boolean> {
  if (Date.now() < bypassUntil) {
    bypassUntil = 0;
    useToolbox.setState({ guard: null });
    return true;
  }
  let diff: string;
  try {
    diff = await gitx.run(root, ["diff", "--cached", "--no-color", "--no-ext-diff", "-U0"]);
  } catch {
    return true;
  }
  const { findings, envFiles } = scanDiff(diff);
  if (!findings.length && !envFiles.length) {
    useToolbox.setState({ guard: null });
    return true;
  }
  useToolbox.setState({ guard: { findings, envFiles, proceed } });
  return false;
}

/** "Commit anyway": skip the scan for the next commit attempt and run it (`run` = the panel's current commit). */
export function commitAnyway(run?: () => void) {
  const g = useToolbox.getState().guard;
  if (!g) return;
  bypassUntil = Date.now() + 15000;
  useToolbox.setState({ guard: null });
  (run ?? g.proceed)();
}

export function dismissGuard() {
  useToolbox.setState({ guard: null });
}
