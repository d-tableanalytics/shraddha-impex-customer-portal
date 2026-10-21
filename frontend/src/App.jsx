import { RouterProvider } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { Toaster } from "react-hot-toast";
import { router } from "./routes";
import { useEffect } from "react";
import { initSocket, onBrandsUpdated } from "./services/socketService";
import { useUserStore } from "./store/userStore";
import { useThemeStore } from "./store/themeStore";



function App() {
  const fetchUser = useUserStore((state) => state.fetchUser);
  const refreshSession = useUserStore((state) => state.refreshSession);
  const initTheme = useThemeStore((state) => state.initTheme);

  useEffect(() => {
    initTheme();
    initSocket();
    fetchUser();
  }, [fetchUser, initTheme]);

  // A brand created anywhere appears in every brand list on this screen
  // without a reload.
  useEffect(() => onBrandsUpdated(() => refreshSession()), [refreshSession]);

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