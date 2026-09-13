import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import AndroidApp from "./AndroidApp";
import { installIconFallbacks } from "./icon-fallbacks";
import "./styles.css";
import "./icon-fixes.css";
import "./android.css";

const isAndroid = /Android/i.test(navigator.userAgent);
document.documentElement.dataset.platform = isAndroid ? "android" : "windows";

const storedTheme = localStorage.getItem("nonthub.theme");
const media = window.matchMedia("(prefers-color-scheme: light)");
const resolvedTheme = storedTheme === "dark" || storedTheme === "bright"
  ? storedTheme
  : media.matches ? "bright" : "dark";
document.documentElement.dataset.theme = resolvedTheme;

const favicon = document.querySelector<HTMLLinkElement>("#nonthub-favicon");
if (favicon) favicon.href = "/brand/nonthub.png";

installIconFallbacks();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isAndroid ? <AndroidApp /> : <App />}
  </React.StrictMode>,
);
