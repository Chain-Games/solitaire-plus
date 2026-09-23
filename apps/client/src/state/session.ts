import { create } from 'zustand';
import { ApiError, api, type User } from '../api/client.js';
import { demoUser, xpDemo } from '../shell/xp-view.js';
import { useRankUp } from './rankup.js';

interface SessionState {
  user: User | null;
  /** True until the first /me round-trip completes. */
  loading: boolean;
  /** Amount just credited by the daily top-up (shown once by the shell), 0 otherwise. */
  dailyGranted: number;
  clearDailyGranted: () => void;
  refresh: () => Promise<void>;
  setUser: (u: User | null) => void;
  logout: () => Promise<void>;
}

export const useSession = create<SessionState>((set) => ({
  user: null,
  loading: true,
  dailyGranted: 0,
  clearDailyGranted: () => set({ dailyGranted: 0 }),
  refresh: async () => {
    try {
      const { user, dailyGranted } = await api.me();
      // ?xpDemo=1 (capture fixture, off by default): the mid-rank progress everywhere the user is shown.
      const shown = xpDemo() ? demoUser(user) : user;
      set({ user: shown, loading: false, dailyGranted: dailyGranted ?? 0 });
      // A rank risen since this browser last saw it arms the shell's echo of the ceremony.
      useRankUp.getState().observe(shown);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) set({ user: null, loading: false });
      else set({ loading: false });
    }
  },
  setUser: (user) => {
    set({ user });
    useRankUp.getState().observe(user);
  },
  logout: async () => {
    await api.logout();
    set({ user: null });
  },
}));
