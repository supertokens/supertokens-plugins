import { useState, useEffect } from "react";
import { SuperTokensWrapper } from "supertokens-auth-react";
import { redirectToAuth } from "supertokens-auth-react";

import { usePluginContext } from "../plugin";
import { TenantDetails } from "../types";

const TenantSelector = () => {
  const { api, t } = usePluginContext();
  const { fetchTenants } = api;
  const [tenants, setTenants] = useState<TenantDetails[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const loadTenants = async () => {
      setIsLoading(true);
      try {
        const response = await fetchTenants();
        if (response.status === "OK") {
          setTenants(response.tenants);
        } else {
          console.error("Failed to fetch tenants:", response.message);
        }
      } catch (error) {
        console.error("Error fetching tenants:", error);
      }
      setIsLoading(false);
    };

    loadTenants();
  }, [fetchTenants]);

  const handleContinue = async () => {
    if (!selectedTenantId) {
return;
}

    setIsSubmitting(true);
    try {
      redirectToAuth({
        queryParams: { tenantId: selectedTenantId },
        redirectBack: false,
      });
    } catch (error) {
      console.error("Failed to redirect:", error);
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          height: "100vh",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        {t("PL_TD_LOADING")}
      </div>
    );
  }

  return (
    <div
      style={{
        maxWidth: "400px",
        margin: "100px auto",
        padding: "32px",
        backgroundColor: "#fff",
        borderRadius: "8px",
        boxShadow: "0 2px 10px rgba(0, 0, 0, 0.1)",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <div style={{ marginBottom: "24px", textAlign: "center" }}>
        <h2 style={{ margin: "0 0 8px 0", fontSize: "24px", color: "#333" }}>{t("PL_TD_SELECT_TENANT_HEADING")}</h2>
        <p style={{ margin: "0", color: "#666", fontSize: "14px" }}>{t("PL_TD_SELECT_TENANT_SUBHEADING")}</p>
      </div>

      <div style={{ marginBottom: "24px" }}>
        <label
          htmlFor="tenant-select"
          style={{
            display: "block",
            marginBottom: "8px",
            fontWeight: "500",
            color: "#333",
            fontSize: "14px",
          }}
        >
          {t("PL_TD_AVAILABLE_TENANTS")}
        </label>
        <select
          id="tenant-select"
          value={selectedTenantId}
          onChange={(e) => setSelectedTenantId(e.target.value)}
          style={{
            width: "100%",
            padding: "12px",
            border: "1px solid #ddd",
            borderRadius: "4px",
            fontSize: "14px",
            backgroundColor: "#fff",
            outline: "none",
            transition: "border-color 0.2s",
          }}
          onFocus={(e) => (e.target.style.borderColor = "#007bff")}
          onBlur={(e) => (e.target.style.borderColor = "#ddd")}
        >
          <option value="">{t("PL_TD_DEFAULT_OPTION")}</option>
          {tenants.map((tenant) => (
            <option key={tenant.tenantId} value={tenant.tenantId}>
              {tenant.tenantId === "public" ? "Public Tenant" : tenant.tenantId}
            </option>
          ))}
        </select>
      </div>

      <button
        onClick={handleContinue}
        disabled={!selectedTenantId || isSubmitting}
        style={{
          width: "100%",
          padding: "12px",
          backgroundColor: selectedTenantId && !isSubmitting ? "#007bff" : "#ccc",
          color: "#fff",
          border: "none",
          borderRadius: "4px",
          fontSize: "16px",
          fontWeight: "500",
          cursor: selectedTenantId && !isSubmitting ? "pointer" : "not-allowed",
          transition: "background-color 0.2s",
        }}
      >
        {isSubmitting ? "Continuing..." : "Continue"}
      </button>

      {tenants.length === 0 && !isLoading && (
        <div
          style={{
            marginTop: "16px",
            padding: "12px",
            backgroundColor: "#f8f9fa",
            border: "1px solid #e9ecef",
            borderRadius: "4px",
            textAlign: "center",
            color: "#666",
            fontSize: "14px",
          }}
        >
          {t("PL_TD_NO_TENANT_AVAILABLE")}
        </div>
      )}
    </div>
  );
};

export const SelectTenantPage = () => {
  return (
    <SuperTokensWrapper>
      <TenantSelector />
    </SuperTokensWrapper>
  );
};
