/**
 * Topbar — currently a slim placeholder.
 *
 * The previous tenant chrome (project picker / role tag / user / logout) was
 * removed because the platform now runs without auth. If we re-introduce
 * multi-tenancy we'll bring back the project switcher and user menu, but for
 * now the bar just provides vertical spacing + future-action room.
 */
export function Topbar() {
  return <div className="topbar" />;
}
