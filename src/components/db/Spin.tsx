import { useStore } from "../../store";

/** Loading icon that respects Settings › Reduce motion. */
export default function Spin({ on = true, icon = "refresh" }: { on?: boolean; icon?: string }) {
  const still = useStore((s) => s.settings.reduceMotion ?? false);
  return <i className={`codicon codicon-${on ? `loading${still ? "" : " codicon-modifier-spin"}` : icon}`} aria-hidden="true" />;
}
