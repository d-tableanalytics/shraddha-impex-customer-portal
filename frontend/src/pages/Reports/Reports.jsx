import { Navigate } from 'react-router-dom';
import { Card, CardContent } from '../../components/ui/Card';
import { TrendingUp, Package } from 'lucide-react';
import { useUserStore } from '../../store/userStore';

export const Reports = () => {
  const { user } = useUserStore();
  if (user && user.role !== 'Admin') {
    return <Navigate to="/" replace />;
  }

  const topProducts = [
    { name: 'Precision Digital Caliper', sales: 1245 },
    { name: 'Heavy Duty Impact Wrench', sales: 980 },
    { name: 'Industrial Multimeter Pro', sales: 850 },
    { name: 'Laser Distance Meter', sales: 720 },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-xl font-bold text-slate-800 tracking-tight">System Reports</h2>
          <p className="text-sm text-slate-500 mt-1">Analytics and performance metrics.</p>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card className="bg-white border-slate-200">
          <CardContent className="p-5 flex flex-col gap-3">
            <div className="flex justify-between items-start">
              <div className="w-10 h-10 rounded-lg bg-indigo-50 flex items-center justify-center text-indigo-600">
                <Package size={20} />
              </div>
              <span className="text-xs font-bold text-success-600 bg-success-50 px-2 py-1 rounded-full flex items-center gap-1">
                <TrendingUp size={12} /> +8.2%
              </span>
            </div>
            <div>
              <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Bookings Processed</p>
              <h3 className="text-2xl font-bold text-slate-900">1,284</h3>
            </div>
          </CardContent>
        </Card>
        
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Top Products */}
        <Card className="bg-white border-slate-200">
          <CardContent className="p-6">
            <h3 className="text-sm font-bold text-slate-800 mb-6 uppercase tracking-wider">Top Selling Products</h3>
            <div className="flex flex-col gap-4">
              {topProducts.map((product, index) => (
                <div key={index} className="flex flex-col gap-2">
                  <div className="flex justify-between items-center text-sm">
                    <span className="font-semibold text-slate-700">{product.name}</span>
                    <span className="font-bold text-slate-900">{product.sales} units</span>
                  </div>
                  <div className="w-full bg-slate-100 rounded-full h-2">
                    <div 
                      className="bg-indigo-500 h-2 rounded-full" 
                      style={{ width: `${(product.sales / topProducts[0].sales) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};
