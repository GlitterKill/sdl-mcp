/**
 * Helpers — secondary JavaScript/JSX fixture with component-style functions.
 */

const { transformResponse, validatePayload } = require("./legacy-adapter");

function formatDate(timestamp) {
  return new Date(timestamp).toISOString().split("T")[0];
}

function ErrorBanner({ message }) {
  return {
    type: "div",
    props: { className: "error-banner" },
    children: [message],
  };
}

function LoadingSpinner({ size }) {
  return {
    type: "div",
    props: { className: `spinner spinner-${size || "md"}` },
    children: [],
  };
}

function DataCard({ title, value, unit }) {
  const formatted = typeof value === "number" ? value.toLocaleString() : value;
  return {
    type: "div",
    props: { className: "data-card" },
    children: [
      { type: "h3", children: [title] },
      { type: "span", children: [`${formatted} ${unit || ""}`] },
    ],
  };
}

function processApiResponse(raw) {
  const transformed = transformResponse(raw);
  if (!validatePayload(transformed)) {
    return { error: "Invalid response payload" };
  }
  return transformed;
}

module.exports = {
  formatDate,
  ErrorBanner,
  LoadingSpinner,
  DataCard,
  processApiResponse,
};
