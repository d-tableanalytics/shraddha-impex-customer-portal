import { RouterProvider } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "react-hot-toast";
import { router } from "./routes";
import { useEffect } from "react";
import { initSocket } from "./services/socketService";
import { useUserStore } from "./store/userStore";
import { useThemeStore } from "./store/themeStore";
import { useHrmsStore } from "./store/hrmsStore";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});


function App() {
  const fetchUser = useUserStore((state) => state.fetchUser);
  const initTheme = useThemeStore((state) => state.initTheme);
  const loadHrms = useHrmsStore((state) => state.load);

  useEffect(() => {
    initTheme();
    initSocket();
    fetchUser();
    // Resolved once at startup so the sidebar knows whether to show HRMS at
    // all. Returns 403 for a customer, which the store treats as the expected
    // "no HRMS access" answer rather than an error — so the portal is never
    // blocked or degraded by it.
    loadHrms();
  }, [fetchUser, initTheme, loadHrms]);

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster
        position="top-right"
        toastOptions={{
          className:
            "text-xs font-bold text-slate-800 bg-white border border-slate-200 shadow-enterprise rounded-lg px-4 py-2.5 select-none",
          duration: 3500,
        }}
      />
    </QueryClientProvider>
  );
}

export default App;