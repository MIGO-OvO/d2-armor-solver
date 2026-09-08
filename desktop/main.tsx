import { createRoot } from "react-dom/client";
import { DesktopApp } from "./DesktopApp";
import "../src/styles/app.css";
import "./desktop.css";

// The shared imperative solver initializes once per document. Do not enable
// StrictMode's effect replay or hot-remount this compatibility boundary.
createRoot(document.getElementById("root")!).render(<DesktopApp />);
