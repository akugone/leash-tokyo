import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

/// The landing page lives at `/`. The dashboard keeps its old URLs: `/app`, or any `/?label=...` link
/// printed by `script/demo.sh setup`.
const params = new URLSearchParams(window.location.search);
const isDashboard =
  window.location.pathname.startsWith("/app") || params.has("label") || params.has("rpc");

const root = createRoot(document.getElementById("root")!);

if (isDashboard) {
  Promise.all([import("./App"), import("./styles.css")]).then(([{ App }]) =>
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    ),
  );
} else {
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", "light");
  Promise.all([import("./landing/Landing"), import("./landing/landing.css")]).then(
    ([{ Landing }]) =>
      root.render(
        <StrictMode>
          <Landing />
        </StrictMode>,
      ),
  );
}
