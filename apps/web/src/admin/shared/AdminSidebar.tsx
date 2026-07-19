export type AdminSection =
  | "dashboard"
  | "users"
  | "subscriptions"
  | "integrations"
  | "logs"
  | "webhooks";

const NAV: Array<{ id: AdminSection; label: string }> = [
  { id: "dashboard", label: "Dashboard" },
  { id: "users", label: "Users" },
  { id: "subscriptions", label: "Subscriptions" },
  { id: "integrations", label: "Integrations" },
  { id: "logs", label: "Logs" },
  { id: "webhooks", label: "Webhooks" },
];

export function sectionTitle(section: AdminSection): string {
  return NAV.find((n) => n.id === section)?.label ?? "Admin";
}

export function AdminSidebar({
  activeSection,
  onSectionChange,
}: {
  activeSection: AdminSection;
  onSectionChange: (s: AdminSection) => void;
}) {
  return (
    <nav className="admin-sidebar">
      <div className="admin-sidebar__brand">AI Connect Admin</div>
      <ul className="admin-sidebar__nav">
        {NAV.map((n) => (
          <li key={n.id}>
            <button
              type="button"
              className={`admin-sidebar__item${
                n.id === activeSection ? " admin-sidebar__item--active" : ""
              }`}
              onClick={() => onSectionChange(n.id)}
            >
              {n.label}
            </button>
          </li>
        ))}
      </ul>
      <a className="admin-sidebar__back" href="/">
        ← Back to app
      </a>
    </nav>
  );
}
