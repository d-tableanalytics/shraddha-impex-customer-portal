import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useNavigate } from 'react-router-dom';
import { useUserStore } from '../../store/userStore';
import { Button } from '../../components/ui/Button';
import { Building2, Eye, EyeOff } from 'lucide-react';
import toast from 'react-hot-toast';

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(5, 'Password must be at least 5 characters'),
});

export const Login = () => {
  const navigate = useNavigate();
  const { login, loading, error } = useUserStore();
  // Reveal the typed password. Off on every mount - a revealed password must
  // never be what the next person at this machine finds on screen.
  const [showPassword, setShowPassword] = useState(false);

  const { register, handleSubmit, formState: { errors } } = useForm({
    resolver: zodResolver(loginSchema),
  });

  const onSubmit = async (data) => {
    const success = await login(data);
    if (!success) return;

    toast.success('Login successful!');
    navigate('/');
  };

  return (
    <div>

      <h2 className="text-2xl font-black text-slate-900 mb-1">Sign in to your account</h2>
      <p className="text-sm text-slate-500 font-medium mb-8">Welcome to the Shraddha Impex Portal</p>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <div>
          <label className="block text-sm font-bold text-slate-700 mb-1">Email address</label>
          <input
            {...register('email')}
            type="email"
            autoComplete="email"
            className="w-full px-3 py-2 border border-slate-300 rounded-md shadow-sm placeholder-slate-400 focus:outline-none focus:ring-2 text-sm focus:ring-red-500 focus:border-red-500"
            placeholder="customer@example.com"
          />
          {errors.email && <p className="mt-1 text-xs text-error-600">{errors.email.message}</p>}
        </div>

        <div>
          <label className="block text-sm font-bold text-slate-700 mb-1">Password</label>
          <div className="relative">
            <input
              {...register('password')}
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              // pr-10 keeps the typed text from running under the button.
              className="w-full px-3 py-2 pr-10 border border-slate-300 rounded-md shadow-sm placeholder-slate-400 focus:outline-none focus:ring-2 text-sm focus:ring-red-500 focus:border-red-500"
            />
            {/* type="button" is load-bearing: the default inside a <form> is
                submit, so without it the eye would try to log you in. */}
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
              title={showPassword ? 'Hide password' : 'Show password'}
              className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-slate-600 focus:outline-none focus:text-red-600 rounded-r-md"
            >
              {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
          {errors.password && <p className="mt-1 text-xs text-error-600">{errors.password.message}</p>}
        </div>

        {error && (
          <div className="p-3 bg-error-50 text-error-700 text-sm rounded-md border border-error-200 font-medium">
            {error}
          </div>
        )}

        <div className="flex flex-col gap-3 pt-2">
          <Button type="submit" variant="primary" className="w-full bg-red-600 hover:bg-red-700 border-red-600" disabled={loading}>
            {loading ? 'Signing in...' : 'Sign In'}
          </Button>
        </div>
      </form>
    </div>
  );
};
