export function safeReturnTo() {
  const value = new URLSearchParams(window.location.search).get("returnTo");
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/";
}
