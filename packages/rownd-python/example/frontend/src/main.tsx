import React from "react";
import ReactDOM from "react-dom/client";
import { RowndProvider } from "@supertokens/rownd-react";
import App from "./App";
import "./styles.css";

export type BootstrapConfig = {
  supertokens: {
    appInfo: {
      appName: string;
      apiDomain: string;
      apiBasePath: string;
    };
  };
  appKey: string;
  hubBaseUrl: string;
  exampleName: string;
};

function Bootstrap() {
  const [config, setConfig] = React.useState<BootstrapConfig | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;

    async function loadConfig() {
      try {
        const response = await fetch("/example-bootstrap", {
          credentials: "include",
        });
        if (!response.ok) {
          throw new Error(`Failed to load example bootstrap config: ${response.status}`);
        }

        const bootstrapConfig = (await response.json()) as BootstrapConfig;
        if (!cancelled) {
          setConfig(bootstrapConfig);
        }
      } catch (err) {
        if (!cancelled) {
          setError(String(err));
        }
      }
    }

    void loadConfig();

    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return <App bootstrapError={error} />;
  }

  if (!config) {
    return <App isBootstrapping />;
  }

  return (
    <RowndProvider
      appKey={config.appKey}
      hubUrlOverride={config.hubBaseUrl}
      supertokens={config.supertokens}
    >
      <App config={config} />
    </RowndProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Bootstrap />);
