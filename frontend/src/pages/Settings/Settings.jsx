import { useState, useRef } from 'react';
import { Card, CardContent } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { User, Mail, Building, Shield, Key, Trash2 } from 'lucide-react';
import { useUserStore } from '../../store/userStore';
import { motion } from 'framer-motion';
import toast from 'react-hot-toast';

export const Settings = () => {
  const { user, updateProfile, changePassword } = useUserStore();
  const [activeTab, setActiveTab] = useState('profile');

  const isAdmin = user?.role === 'Admin';

  // The Security (change password) tab is available to admins only.
  const tabs = [
    { id: 'profile', label: 'My Profile', icon: User },
    ...(isAdmin ? [{ id: 'security', label: 'Security', icon: Shield }] : []),
  ];

  // --- Profile ---
  const [name, setName] = useState(user?.user || user?.name || '');
  const [avatar, setAvatar] = useState(user?.avatar || null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [removingPhoto, setRemovingPhoto] = useState(false);
  const fileRef = useRef(null);

  const handlePhotoPick = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 1024 * 1024) {
      toast.error('Please choose an image under 1 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setAvatar(reader.result); // data URL
    reader.readAsDataURL(file);
  };

  // Clear the photo and persist immediately, so removal sticks without
  // needing a separate Save.
  const handleRemovePhoto = async () => {
    setRemovingPhoto(true);
    const res = await updateProfile({ user: name, avatar: null });
    setRemovingPhoto(false);
    if (res.success) {
      setAvatar(null);
      if (fileRef.current) fileRef.current.value = ''; // allow re-picking the same file
      toast.success('Photo removed');
    } else {
      toast.error(res.error || 'Failed to remove photo');
    }
  };

  const handleSaveProfile = async () => {
    setSavingProfile(true);
    const res = await updateProfile({ user: name, avatar });
    setSavingProfile(false);
    if (res.success) toast.success('Profile updated');
    else toast.error(res.error || 'Failed to update profile');
  };

  // --- Security (change own password) ---
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [savingPw, setSavingPw] = useState(false);

  const handleUpdatePassword = async () => {
    if (!pw.current || !pw.next) {
      toast.error('Please fill in all password fields.');
      return;
    }
    if (pw.next.length < 5) {
      toast.error('New password must be at least 5 characters.');
      return;
    }
    if (pw.next !== pw.confirm) {
      toast.error('New passwords do not match.');
      return;
    }
    setSavingPw(true);
    const res = await changePassword(pw.current, pw.next);
    setSavingPw(false);
    if (res.success) {
      toast.success('Password updated');
      setPw({ current: '', next: '', confirm: '' });
    } else {
      toast.error(res.error || 'Failed to update password');
    }
  };

  const initial = (name || user?.email || 'U').charAt(0);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-xl font-bold text-slate-800 tracking-tight">Account Settings</h2>
          <p className="text-sm text-slate-500 mt-1">
            {isAdmin
              ? 'Manage your personal profile and security.'
              : 'Manage your personal profile.'}
          </p>
        </div>
      </div>

      <div className="flex flex-col md:flex-row gap-8">
        {/* Sidebar Tabs — hidden when there is only one section (profile only),
            since a single-item tab strip is just visual noise. */}
        {tabs.length > 1 && (
        <div className="w-full md:w-64 flex flex-col gap-1 p-2 bg-slate-50/80 rounded-2xl border border-slate-200/60 shadow-inner h-fit">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`relative flex items-center gap-3 px-4 py-3.5 rounded-xl text-sm font-bold transition-all z-10 overflow-hidden ${
                activeTab === tab.id
                ? 'text-white shadow-md shadow-[#1a5b9e]/20'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/50'
              }`}
            >
              {activeTab === tab.id && (
                <motion.div
                  layoutId="activeTab_settings"
                  className="absolute inset-0 bg-linear-to-r from-[#1a5b9e] to-[#15467a] z-[-1]"
                  transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
                />
              )}
              <tab.icon size={18} className={activeTab === tab.id ? 'text-white/90' : 'text-slate-400'} />
              {tab.label}
            </button>
          ))}
        </div>
        )}

        {/* Content Area */}
        <div className="flex-1">
          {activeTab === 'profile' && (
            <div className="flex flex-col gap-6">
              <Card>
                <CardContent className="p-6">
                  <h3 className="text-lg font-bold text-slate-800 mb-6">Profile Information</h3>

                  <div className="flex flex-col md:flex-row gap-8 items-start">
                    <div className="flex flex-col items-center gap-4">
                      <div className="w-32 h-32 rounded-full bg-slate-200 border-4 border-white shadow-md flex items-center justify-center text-4xl font-black text-slate-500 uppercase overflow-hidden">
                        {avatar ? (
                          <img src={avatar} alt="Profile" className="w-full h-full object-cover" />
                        ) : (
                          initial
                        )}
                      </div>
                      <input ref={fileRef} type="file" accept="image/*" onChange={handlePhotoPick} className="hidden" />
                      <div className="flex flex-col items-center gap-2">
                        <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                          {avatar ? 'Change Photo' : 'Upload Photo'}
                        </Button>
                        {avatar && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={handleRemovePhoto}
                            disabled={removingPhoto}
                            className="text-error-600 border-error-200 hover:bg-error-50"
                          >
                            <Trash2 size={14} className="mr-1.5" />
                            {removingPhoto ? 'Removing...' : 'Remove Photo'}
                          </Button>
                        )}
                      </div>
                    </div>

                    <div className="flex-1 w-full flex flex-col gap-6">
                      {/* Full Name is the only editable field, so it leads on its
                          own row; the read-only details sit paired below it. */}
                      <div className="flex flex-col gap-1.5">
                        <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Full Name</label>
                        <div className="relative">
                          <User className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your full name" className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 font-medium text-slate-800" />
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                        <div className="flex flex-col gap-1.5">
                          <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Email Address</label>
                          <div className="relative">
                            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                            <input type="email" defaultValue={user?.email} disabled className="w-full pl-10 pr-4 py-2 border border-slate-200 bg-slate-50 rounded-lg outline-none font-medium text-slate-500 cursor-not-allowed" />
                          </div>
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Company</label>
                          <div className="relative">
                            <Building className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                            <input type="text" defaultValue={user?.company || '—'} disabled className="w-full pl-10 pr-4 py-2 border border-slate-200 bg-slate-50 rounded-lg outline-none font-medium text-slate-500 cursor-not-allowed" />
                          </div>
                        </div>
                      </div>

                      <p className="text-xs text-slate-400">
                        Email and company are managed by your administrator and can't be edited here.
                      </p>
                    </div>
                  </div>

                  <div className="mt-8 flex justify-end">
                    <Button variant="primary" onClick={handleSaveProfile} disabled={savingProfile}>
                      {savingProfile ? 'Saving...' : 'Save Changes'}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {activeTab === 'security' && isAdmin && (
            <Card>
              <CardContent className="p-6">
                <h3 className="text-lg font-bold text-slate-800 mb-1">Change Password</h3>
                <p className="text-sm text-slate-500 mb-6">Update the password you use to sign in.</p>

                <div className="flex flex-col gap-6 max-w-md">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Current Password</label>
                    <div className="relative">
                      <Key className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                      <input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} placeholder="••••••••" className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 font-medium text-slate-800" />
                    </div>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">New Password</label>
                    <div className="relative">
                      <Key className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                      <input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} placeholder="••••••••" className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 font-medium text-slate-800" />
                    </div>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Confirm New Password</label>
                    <div className="relative">
                      <Key className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                      <input type="password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} placeholder="••••••••" className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 font-medium text-slate-800" />
                    </div>
                  </div>

                  <div className="mt-2">
                    <Button variant="primary" onClick={handleUpdatePassword} disabled={savingPw}>
                      {savingPw ? 'Updating...' : 'Update Password'}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

        </div>
      </div>
    </div>
  );
};
