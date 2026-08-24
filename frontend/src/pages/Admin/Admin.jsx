import { motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { Users, Boxes, Key } from "lucide-react";
import { Card, CardHeader, CardTitle } from "../../components/ui/Card";
import { Badge } from "../../components/ui/Badge";
import { useUserStore } from "../../store/userStore";

export const Admin = () => {
  const navigate = useNavigate();
  const { user } = useUserStore();
  const adminCards = [
    {
      name: "User Management",
      desc: "Add customers and set/change their category (MSIL / Customer).",
      icon: Users,
      path: "/admin/users",
    },
    {
      name: "Access Permissions",
      desc: "Manage role-based access via the permission matrix.",
      icon: Key,
      path: "/admin/permissions",
    },
    {
      name: "Inventory",
      desc: "Browse live stock across all brands.",
      icon: Boxes,
      path: "/inventory",
    },
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col gap-6"
    >
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-bold text-slate-900">
          Admin Control Panel
        </h1>
        <Badge variant="primary">{user?.user || user?.company || user?.email || user?.role || "Admin"}</Badge>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {adminCards.map((card) => (
          <Card
            key={card.name}
            className="hover:border-primary-300 transition-colors cursor-pointer select-none"
            onClick={() => navigate(card.path)}
          >
            <CardHeader className="flex flex-row items-center gap-4">
              <div className="w-10 h-10 bg-slate-50 border border-slate-100 rounded-lg flex items-center justify-center text-primary-600 shadow-sm">
                <card.icon size={18} />
              </div>
              <div>
                <CardTitle className="text-sm font-bold text-slate-800">
                  {card.name}
                </CardTitle>
                <p className="text-[11px] text-slate-400 font-semibold">
                  {card.desc}
                </p>
              </div>
            </CardHeader>
          </Card>
        ))}
      </div>
    </motion.div>
  );
};
export default Admin;
