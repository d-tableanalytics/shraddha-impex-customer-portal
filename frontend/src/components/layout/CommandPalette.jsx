import { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, FileText, Package, ShoppingCart, LayoutDashboard, Command } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';

const COMMANDS = [
  { id: 1, name: 'Dashboard', icon: LayoutDashboard, path: '/' },
  { id: 2, name: 'Create Booking', icon: ShoppingCart, path: '/orders/new' },
  { id: 3, name: 'Booking History', icon: FileText, path: '/orders/history' },
  { id: 4, name: 'Bulk Upload', icon: Package, path: '/orders/bulk-upload' },
];

export const CommandPalette = () => {
  const { commandPaletteOpen, setCommandPaletteOpen } = useUIStore();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setCommandPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setCommandPaletteOpen]);

  useEffect(() => {
    if (commandPaletteOpen) {
      setTimeout(() => inputRef.current?.focus(), 100);
      setQuery('');
      setActiveIndex(0);
    }
  }, [commandPaletteOpen]);

  const filteredCommands = COMMANDS.filter(cmd =>
    cmd.name.toLowerCase().includes(query.toLowerCase())
  );

  const handleSelect = (path) => {
    setCommandPaletteOpen(false);
    navigate(path);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      setCommandPaletteOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex(prev => Math.min(prev + 1, filteredCommands.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && filteredCommands[activeIndex]) {
      handleSelect(filteredCommands[activeIndex].path);
    }
  };

  if (!commandPaletteOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] sm:pt-[20vh] px-4">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.5 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm"
          onClick={() => setCommandPaletteOpen(false)}
        />

        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: -20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: -20 }}
          transition={{ type: 'spring', stiffness: 300, damping: 30 }}
          className="relative w-full max-w-xl bg-white rounded-xl shadow-2xl overflow-hidden border border-slate-200"
        >
          <div className="flex items-center px-4 py-4 border-b border-slate-200">
            <Search className="text-slate-400 mr-3" size={20} />
            <input
              ref={inputRef}
              className="flex-1 bg-transparent outline-none text-slate-800 placeholder-slate-400 text-lg"
              placeholder="Search or jump to..."
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={onKeyDown}
            />
            <div className="hidden sm:flex items-center gap-1 text-xs text-slate-400 font-semibold border border-slate-200 rounded px-1.5 py-0.5 bg-slate-50">
              <Command size={12} /> K
            </div>
          </div>

          <div className="max-h-[60vh] overflow-y-auto p-2">
            {filteredCommands.length === 0 ? (
              <div className="text-center py-12 text-slate-500">
                No results found for "{query}"
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                {filteredCommands.map((cmd, idx) => {
                  const Icon = cmd.icon;
                  return (
                    <div
                      key={cmd.id}
                      onClick={() => handleSelect(cmd.path)}
                      className={`flex items-center gap-3 px-4 py-3 rounded-lg cursor-pointer transition-colors ${
                        activeIndex === idx
                          ? 'bg-primary-50 text-primary-700'
                          : 'hover:bg-slate-50 text-slate-700'
                      }`}
                      onMouseEnter={() => setActiveIndex(idx)}
                    >
                      <div className={`p-1.5 rounded-md ${activeIndex === idx ? 'bg-primary-100' : 'bg-slate-100'}`}>
                        <Icon size={18} className={activeIndex === idx ? 'text-primary-600' : 'text-slate-500'} />
                      </div>
                      <span className="font-medium text-sm">{cmd.name}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          
          <div className="bg-slate-50 border-t border-slate-100 px-4 py-2 text-xs text-slate-500 flex justify-between items-center">
            <span>Use <strong className="text-slate-700">↑↓</strong> to navigate, <strong className="text-slate-700">Enter</strong> to select</span>
            <span><strong className="text-slate-700">Esc</strong> to close</span>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
