import { create } from 'zustand';
import { dashboardApi } from '../lib/api';
import type { DashboardStats } from '../types';

interface DashboardState {
  stats: DashboardStats | null;
  isLoading: boolean;
  error: string | null;

  fetchStats: () => Promise<void>;
}

export const useDashboardStore = create<DashboardState>((set) => ({
  stats: null,
  isLoading: false,
  error: null,

  fetchStats: async () => {
    set({ isLoading: true, error: null });
    try {
      const stats = await dashboardApi.getStats();
      set({ stats, isLoading: false });
    } catch (error: any) {
      set({ error: error.response?.data?.error || 'Failed to fetch dashboard stats', isLoading: false });
    }
  },
}));
