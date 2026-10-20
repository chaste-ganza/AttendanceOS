import { createContext, useContext, useEffect, useMemo, useState } from "react"

const ThemeProviderContext = createContext({
  theme: "system",
  setTheme: () => null,
})

export function ThemeProvider({
  children,
  defaultTheme = "system",
  ...props
}) {
  const [theme, setTheme] = useState(defaultTheme)
  const [systemTheme, setSystemTheme] = useState(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  )
  const resolvedTheme = theme === "system" ? systemTheme : theme

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
    const updateSystemTheme = (event) => setSystemTheme(event.matches ? "dark" : "light")
    mediaQuery.addEventListener("change", updateSystemTheme)
    return () => mediaQuery.removeEventListener("change", updateSystemTheme)
  }, [])

  useEffect(() => {
    const root = window.document.documentElement
    root.classList.remove("light", "dark")
    root.classList.add(resolvedTheme)
  }, [resolvedTheme])

  const value = useMemo(() => ({
    theme,
    resolvedTheme,
    setTheme: (nextTheme) => {
      window.document.documentElement.classList.remove("light", "dark")
      window.document.documentElement.classList.add(
        nextTheme === "system" ? systemTheme : nextTheme
      )
      setTheme(nextTheme)
    },
  }), [theme, resolvedTheme, systemTheme])

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  )
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext)
  if (context === undefined)
    throw new Error("useTheme must be used within a ThemeProvider")
  return context
}
