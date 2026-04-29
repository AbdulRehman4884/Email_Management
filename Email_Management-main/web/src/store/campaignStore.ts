import { create } from 'zustand';
import { campaignApi } from '../lib/api';
import type { Campaign, CreateCampaignPayload, UpdateCampaignPayload, CampaignStats, Recipient, UploadResponse } from '../types';

interface CampaignState {
  campaigns: Campaign[];
  currentCampaign: Campaign | null;
  currentStats: CampaignStats | null;
  recipients: Recipient[];
  recipientsTotal: number;
  isLoading: boolean;
  error: string | null;

  // Actions
  fetchCampaigns: () => Promise<void>;
  fetchCampaign: (id: number) => Promise<void>;
  createCampaign: (payload: CreateCampaignPayload) => Promise<Campaign>;
  updateCampaign: (id: number, payload: UpdateCampaignPayload) => Promise<void>;
  deleteCampaign: (id: number) => Promise<void>;
  startCampaign: (id: number) => Promise<{ status: 'scheduled' | 'in_progress'; message: string }>;
  pauseCampaign: (id: number) => Promise<void>;
  resumeCampaign: (id: number) => Promise<void>;
  fetchStats: (id: number) => Promise<void>;
  uploadRecipients: (id: number, file: File) => Promise<UploadResponse>;
  fetchRecipients: (id: number, page?: number, limit?: number) => Promise<void>;
  markRecipientReplied: (campaignId: number, recipientId: number) => Promise<void>;
  deleteRecipient: (campaignId: number, recipientId: number, page?: number, limit?: number) => Promise<void>;
  clearError: () => void;
  clearCurrentCampaign: () => void;
}

export const useCampaignStore = create<CampaignState>((set, get) => ({
  campaigns: [],
  currentCampaign: null,
  currentStats: null,
  recipients: [],
  recipientsTotal: 0,
  isLoading: false,
  error: null,

  fetchCampaigns: async () => {
    set({ isLoading: true, error: null });
    try {
      const campaigns = await campaignApi.getAll();
      set({ campaigns, isLoading: false });
    } catch (error: any) {
      set({ error: error.response?.data?.error || 'Failed to fetch campaigns', isLoading: false });
    }
  },

  fetchCampaign: async (id: number) => {
    set({ isLoading: true, error: null });
    try {
      const campaign = await campaignApi.getById(id);
      set({ currentCampaign: campaign, isLoading: false });
    } catch (error: any) {
      set({ error: error.response?.data?.error || 'Failed to fetch campaign', isLoading: false });
    }
  },

  createCampaign: async (payload: CreateCampaignPayload) => {
    set({ isLoading: true, error: null });
    try {
      const campaign = await campaignApi.create(payload);
      set((state) => ({
        campaigns: [...state.campaigns, campaign],
        isLoading: false,
      }));
      return campaign;
    } catch (error: any) {
      set({ error: error.response?.data?.error || 'Failed to create campaign', isLoading: false });
      throw error;
    }
  },

  updateCampaign: async (id: number, payload: UpdateCampaignPayload) => {
    set({ isLoading: true, error: null });
    try {
      const updated = await campaignApi.update(id, payload);
      set((state) => ({
        campaigns: state.campaigns.map((c) => (c.id === id ? updated : c)),
        currentCampaign: state.currentCampaign?.id === id ? updated : state.currentCampaign,
        isLoading: false,
      }));
    } catch (error: any) {
      set({ error: error.response?.data?.error || 'Failed to update campaign', isLoading: false });
      throw error;
    }
  },

  deleteCampaign: async (id: number) => {
    set({ isLoading: true, error: null });
    try {
      await campaignApi.delete(id);
      set((state) => ({
        campaigns: state.campaigns.filter((c) => c.id !== id),
        isLoading: false,
      }));
    } catch (error: any) {
      set({ error: error.response?.data?.error || 'Failed to delete campaign', isLoading: false });
      throw error;
    }
  },

  startCampaign: async (id: number) => {
    set({ isLoading: true, error: null });
    try {
      const result = await campaignApi.start(id);
      set((state) => ({
        campaigns: state.campaigns.map((c) =>
          c.id === id ? { ...c, status: result.status } : c
        ),
        currentCampaign:
          state.currentCampaign?.id === id
            ? { ...state.currentCampaign, status: result.status }
            : state.currentCampaign,
        isLoading: false,
      }));
      return result;
    } catch (error: any) {
      set({ error: error.response?.data?.error || 'Failed to start campaign', isLoading: false });
      throw error;
    }
  },

  pauseCampaign: async (id: number) => {
    set({ isLoading: true, error: null });
    try {
      await campaignApi.pause(id);
      set((state) => ({
        campaigns: state.campaigns.map((c) =>
          c.id === id ? { ...c, status: 'paused' as const } : c
        ),
        currentCampaign:
          state.currentCampaign?.id === id
            ? { ...state.currentCampaign, status: 'paused' as const }
            : state.currentCampaign,
        isLoading: false,
      }));
    } catch (error: any) {
      set({ error: error.response?.data?.error || 'Failed to pause campaign', isLoading: false });
      throw error;
    }
  },

  resumeCampaign: async (id: number) => {
    set({ isLoading: true, error: null });
    try {
      await campaignApi.resume(id);
      set((state) => ({
        campaigns: state.campaigns.map((c) =>
          c.id === id ? { ...c, status: 'in_progress' as const } : c
        ),
        currentCampaign:
          state.currentCampaign?.id === id
            ? { ...state.currentCampaign, status: 'in_progress' as const }
            : state.currentCampaign,
        isLoading: false,
      }));
    } catch (error: any) {
      set({ error: error.response?.data?.error || 'Failed to resume campaign', isLoading: false });
      throw error;
    }
  },

  fetchStats: async (id: number) => {
    try {
      const stats = await campaignApi.getStats(id);
      set({ currentStats: stats });
    } catch (error: any) {
      console.error('Failed to fetch stats:', error);
    }
  },

  uploadRecipients: async (id: number, file: File) => {
    set({ isLoading: true, error: null });
    try {
      const result = await campaignApi.uploadRecipients(id, file);
      // Refresh campaign to get updated recipient count
      await get().fetchCampaign(id);
      set({ isLoading: false });
      return result;
    } catch (error: any) {
      set({ error: error.response?.data?.error || 'Failed to upload recipients', isLoading: false });
      throw error;
    }
  },

  fetchRecipients: async (id: number, page = 1, limit = 50) => {
    try {
      const result = await campaignApi.getRecipients(id, page, limit);
      set({ recipients: result.recipients, recipientsTotal: result.total });
    } catch (error: any) {
      console.error('Failed to fetch recipients:', error);
    }
  },

  markRecipientReplied: async (campaignId: number, recipientId: number) => {
    try {
      await campaignApi.markReplied(campaignId, recipientId);
      set((state) => ({
        recipients: state.recipients.map((r) =>
          r.id === recipientId ? { ...r, repliedAt: new Date().toISOString() } : r
        ),
        currentStats: state.currentStats
          ? { ...state.currentStats, repliedCount: (state.currentStats.repliedCount ?? 0) + 1 }
          : null,
      }));
    } catch (error: any) {
      console.error('Failed to mark replied:', error);
    }
  },

  deleteRecipient: async (campaignId: number, recipientId: number, page = 1, limit = 50) => {
    try {
      await campaignApi.deleteRecipient(campaignId, recipientId);
      // Re-fetch the page so rows shift forward from later pages.
      await get().fetchRecipients(campaignId, page, limit);
      await get().fetchCampaign(campaignId);
    } catch (error: any) {
      set({ error: error.response?.data?.error || 'Failed to delete recipient' });
      throw error;
    }
  },

  clearError: () => set({ error: null }),
  clearCurrentCampaign: () => set({ currentCampaign: null, currentStats: null, recipients: [], recipientsTotal: 0 }),
}));
