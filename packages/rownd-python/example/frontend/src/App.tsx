import React from "react";
import { useRownd } from "@supertokens/rownd-react";
import type { BootstrapConfig } from "./main";

type AppProps = {
  config?: BootstrapConfig;
  bootstrapError?: string;
  isBootstrapping?: boolean;
};

type SignInOptions = Parameters<ReturnType<typeof useRownd>["requestSignIn"]>[0];

function App({ config, bootstrapError, isBootstrapping = false }: AppProps) {
  if (bootstrapError) {
    return (
      <Shell
        hostStatus="error"
        authStatus="signed_out"
        protectedResult={{ error: bootstrapError }}
      />
    );
  }

  if (isBootstrapping || !config) {
    return <Shell hostStatus="loading" authStatus="signed_out" />;
  }

  return <AuthenticatedExample config={config} />;
}

function AuthenticatedExample({ config }: { config: BootstrapConfig }) {
  const rownd = useRownd();
  const page = getPage();
  const [scenarioStatus, setScenarioStatus] = React.useState("idle");
  const [protectedResult, setProtectedResult] = React.useState<unknown>("");
  const [showIframe, setShowIframe] = React.useState(false);

  React.useEffect(() => {
    if (!rownd.is_initializing && rownd.is_authenticated && page === "login") {
      window.location.replace("/profile");
    }
  }, [page, rownd.is_authenticated, rownd.is_initializing]);

  React.useEffect(() => {
    if (rownd.is_authenticated) {
      setScenarioStatus(page === "iframe" ? "iframe_sign_in_completed" : "sign_in_completed");
    }
  }, [page, rownd.is_authenticated]);

  function requestSignIn(options: SignInOptions, status: string) {
    setScenarioStatus(status);
    rownd.requestSignIn(options);
  }

  async function fetchProtected() {
    try {
      const response = await fetch(`${config.supertokens.appInfo.apiDomain}/test/protected`, {
        credentials: "include",
      });
      const body = await response.text();
      setProtectedResult(body);
    } catch (error) {
      setProtectedResult({ error: String(error) });
    }
  }

  async function signOut() {
    await rownd.signOut();
    setScenarioStatus("signed_out");
    window.location.href = page === "iframe" ? "/iframe" : "/";
  }

  const isEmbeddedPage = page === "iframe";
  const isProfilePage = page === "profile";
  const authStatus = rownd.is_authenticated ? "signed_in" : "signed_out";
  const loginVisible = !isProfilePage && !rownd.is_authenticated;
  const postLoginVisible = isProfilePage || rownd.is_authenticated;

  return (
    <Shell
      hostStatus={rownd.is_initializing ? "loading" : "ready"}
      authStatus={authStatus}
      exampleName={config.exampleName}
      scenarioStatus={scenarioStatus}
      protectedResult={protectedResult}
    >
      {loginVisible ? (
        <section className="card" id="login-panel">
          <h2>{isEmbeddedPage ? "Embedded flow" : "Flows"}</h2>
          <p>
            {isEmbeddedPage
              ? "Open the Hub auth UI inside this iframe, then choose an enabled method from the Hub modal."
              : "Use these controls to launch each enabled Hub auth method against the Python backend."}
          </p>
          <div className="controls">
            <button
              type="button"
              onClick={() =>
                requestSignIn(
                  undefined,
                  isEmbeddedPage ? "iframe_modal_open_requested" : "modal_open_requested",
                )
              }
            >
              Open Rownd auth UI
            </button>
            {!isEmbeddedPage ? (
              <button
                type="button"
                onClick={() => requestSignIn({ method: "email" }, "email_requested")}
              >
                Sign in with email
              </button>
            ) : null}
            <button
              type="button"
              onClick={() =>
                requestSignIn(
                  { method: "google" },
                  isEmbeddedPage ? "iframe_direct_google_requested" : "direct_google_requested",
                )
              }
            >
              Direct Google login
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() =>
                requestSignIn(
                  {
                    method: "one_tap",
                    method_options: {
                      prompt_parent_id: "google-one-tap-parent",
                    },
                    post_login_redirect: "/profile",
                  },
                  isEmbeddedPage ? "iframe_one_tap_requested" : "one_tap_requested",
                )
              }
            >
              Show Google One Tap
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() =>
                requestSignIn(
                  { method: "anonymous" },
                  isEmbeddedPage ? "iframe_guest_requested" : "guest_requested",
                )
              }
            >
              Continue as guest
            </button>
            {!isEmbeddedPage ? (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setShowIframe(true);
                  setScenarioStatus("iframe_loaded");
                }}
              >
                Authenticate in iframe
              </button>
            ) : null}
          </div>
          <div id="google-one-tap-parent" className="prompt-parent" />
        </section>
      ) : null}

      {showIframe && !isEmbeddedPage ? (
        <section className="card" id="iframe-panel">
          <h2>Embedded iframe</h2>
          <p>
            The iframe page loads the same React app and should use the Hub popup path for Google
            inside the embedded page.
          </p>
          <div id="iframe-scenario">
            <iframe className="iframe-shell" title="All auth iframe scenario" src="/iframe" />
          </div>
        </section>
      ) : null}

      {postLoginVisible ? (
        <section className="card" id="post-login-panel">
          <h2>{isEmbeddedPage ? "Signed in inside the iframe" : "Post-login page"}</h2>
          <p>
            {isEmbeddedPage
              ? "The embedded page does not redirect away after sign-in so you can verify the popup flow completed in place."
              : "Use the protected request to verify the SuperTokens session and Rownd claims."}
          </p>
          <div className="controls">
            <button type="button" onClick={fetchProtected}>
              Fetch protected resource
            </button>
            <button type="button" className="secondary" onClick={signOut}>
              Sign out
            </button>
          </div>
          <ProtectedResult value={protectedResult} />
        </section>
      ) : null}
    </Shell>
  );
}

function Shell({
  children,
  hostStatus,
  authStatus,
  exampleName = "",
  scenarioStatus = "idle",
  protectedResult = "",
}: React.PropsWithChildren<{
  hostStatus: string;
  authStatus: string;
  exampleName?: string;
  scenarioStatus?: string;
  protectedResult?: unknown;
}>) {
  const page = getPage();

  return (
    <main>
      <section className="card hero">
        <p>Rownd + SuperTokens Python React example</p>
        <h1>
          {page === "iframe"
            ? "Iframe auth flow"
            : page === "profile"
              ? "Post-login page"
              : "Try the Hub auth flows"}
        </h1>
        <p>
          {page === "iframe"
            ? "This page is meant to be embedded. Opening Google here should use the Hub iframe popup flow."
            : page === "profile"
              ? "This page loads after an auth flow completes."
              : "This React frontend uses @supertokens/rownd-react and the local FastAPI backend."}
        </p>
      </section>

      <section className="card status-grid">
        <div className="status-row">
          <span className="label">Host:</span> <span data-testid="host-status">{hostStatus}</span>
        </div>
        <div className="status-row">
          <span className="label">Auth:</span> <span data-testid="auth-status">{authStatus}</span>
        </div>
        <div className="status-row">
          <span className="label">Example:</span>{" "}
          <span data-testid="example-name">{exampleName}</span>
        </div>
        <div className="status-row">
          <span className="label">Scenario:</span>{" "}
          <span data-testid="scenario-status">{scenarioStatus}</span>
        </div>
      </section>

      {children}

      {!children ? <ProtectedResult value={protectedResult} /> : null}
    </main>
  );
}

function ProtectedResult({ value }: { value: unknown }) {
  return (
    <pre data-testid="protected-result">
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

function getPage() {
  if (window.location.pathname === "/iframe") {
    return "iframe";
  }

  if (window.location.pathname === "/profile") {
    return "profile";
  }

  return "login";
}

export default App;
