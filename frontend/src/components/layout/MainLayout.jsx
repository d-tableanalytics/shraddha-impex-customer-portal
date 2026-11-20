import { useEffect, Suspense } from "react";
import { Outlet } from "react-router-dom";
import Sidebar from "./Sidebar";
import Navbar from "./Navbar";
import { CommandPalette } from "./CommandPalette";
import { useUserStore } from "../../store/userStore";
import { Loader2 } from "lucide-react";

export const MainLayout = () => {
  return (
    <div className="app-shell w-screen h-screen flex overflow-hidden bg-linear-to-br from-primary-50/60 via-slate-50 to-primary-50/30">
      <Sidebar />

      <div className="flex-1 flex flex-col overflow-hidden">
        <Navbar />

        <main className="flex-1 overflow-y-auto p-6 md:p-8 relative">
          <Suspense fallback={<div className="flex h-full w-full items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-blue-600" /></div>}>
            <Outlet />
          </Suspense>
        </main>
      </div>
      <CommandPalette />
    </div>
  );
};
export default MainLayout;
