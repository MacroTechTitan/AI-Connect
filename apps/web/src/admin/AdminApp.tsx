import "./AdminApp.css";
import { useState } from "react";

import type { GetAccessToken } from "../lib/api";
import {
  AdminSidebar,
  sectionTitle,
  type AdminSection,
} from "./shared/AdminSidebar";
import { DashboardSection } from "./sections/DashboardSection";
import { IntegrationsSection } from "./sections/IntegrationsSection";
import { LogsSection } from "./sections/LogsSection";
import { SubscriptionsSection } from "./sections/SubscriptionsSection";
import { UsersSection } from "./sections/UsersSection";
import { WebhooksSection } from "./sections/WebhooksSection";

export function AdminApp({
  getAccessTokenSilently,
}: {
  getAccessTokenSilently: GetAccessToken;
}) {
  const [section, setSection] = useState<AdminSection>("dashboard");

  const renderSection = () => {
    switch (section) {
      case "dashboard":
        return (
          <DashboardSection getAccessTokenSilently={getAccessTokenSilently} />
        );
      case "users":
        return <UsersSection getAccessTokenSilently={getAccessTokenSilently} />;
      case "subscriptions":
        return (
          <SubscriptionsSection
            getAccessTokenSilently={getAccessTokenSilently}
          />
        );
      case "integrations":
        return (
          <IntegrationsSection
            getAccessTokenSilently={getAccessTokenSilently}
          />
        );
      case "logs":
        return <LogsSection getAccessTokenSilently={getAccessTokenSilently} />;
      case "webhooks":
        return (
          <WebhooksSection getAccessTokenSilently={getAccessTokenSilently} />
        );
    }
  };

  return (
    <div className="admin-app">
      <AdminSidebar activeSection={section} onSectionChange={setSection} />
      <main className="admin-main">
        <h1 className="admin-page-title">{sectionTitle(section)}</h1>
        {renderSection()}
      </main>
    </div>
  );
}
