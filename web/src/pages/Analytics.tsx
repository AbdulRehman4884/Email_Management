import React, { useEffect, useState } from 'react';
import {
  BarChart3,
  TrendingUp,
  Mail,
  Send,
  CheckCircle,
  AlertTriangle,
  AlertCircle,
} from 'lucide-react';
import { useCampaignStore } from '../store';
import { dashboardApi } from '../lib/api';
import type { DashboardStats } from '../types';
import { Card, CardContent, CardHeader, StatsCard, PageLoader } from '../components/ui';

export function Analytics() {
  const { campaigns, isLoading, fetchCampaigns } = useCampaignStore();
  const [dashboardStats, setDashboardStats] = useState<DashboardStats | null>(null);

  useEffect(() => {
    fetchCampaigns();
  }, [fetchCampaigns]);

  useEffect(() => {
    dashboardApi.getStats().then(setDashboardStats).catch(() => setDashboardStats(null));
  }, []);

  // Real aggregate stats from API
  const totalCampaigns = campaigns.length;
  const completedCampaigns = campaigns.filter((c) => c.status === 'completed').length;
  const activeCampaigns = campaigns.filter(
    (c) => c.status === 'in_progress' || c.status === 'scheduled'
  ).length;
  const totalRecipients = campaigns.reduce((sum, c) => sum + (c.recieptCount || 0), 0);

  const totalSent = dashboardStats?.totalEmailsSent ?? 0;
  const totalDelivered = dashboardStats?.totalDelivered ?? 0;
  const totalComplaints = dashboardStats?.totalComplaints ?? 0;
  const totalFailed = dashboardStats?.totalFailed ?? 0;

  const deliveryRate = totalSent > 0 ? Math.round((totalDelivered / totalSent) * 100) : (dashboardStats?.averageDeliveryRate ?? 0);
  const failRate = totalSent > 0 ? Math.round((totalFailed / totalSent) * 100) : 0;

  // Campaign performance breakdown
  const statusBreakdown = [
    { status: 'Completed', count: completedCampaigns, color: 'bg-green-500' },
    { status: 'In Progress', count: campaigns.filter((c) => c.status === 'in_progress').length, color: 'bg-yellow-500' },
    { status: 'Paused', count: campaigns.filter((c) => c.status === 'paused').length, color: 'bg-orange-500' },
    { status: 'Draft', count: campaigns.filter((c) => c.status === 'draft').length, color: 'bg-gray-500' },
    { status: 'Scheduled', count: campaigns.filter((c) => c.status === 'scheduled').length, color: 'bg-blue-500' },
  ];

  if (isLoading && campaigns.length === 0) {
    return <PageLoader />;
  }

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">Analytics</h1>
        <p className="text-gray-400 mt-1">
          Monitor your email campaign performance and metrics
        </p>
      </div>

      {/* Main Stats - real data from dashboard API */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatsCard
          title="Total Emails Sent"
          value={totalSent.toLocaleString()}
          icon={Send}
          iconColor="text-indigo-400"
          iconBgColor="bg-indigo-500/20"
        />
        <StatsCard
          title="Delivered"
          value={totalDelivered.toLocaleString()}
          change={totalSent > 0 ? `${deliveryRate}% delivery rate` : undefined}
          changeType="positive"
          icon={CheckCircle}
          iconColor="text-green-400"
          iconBgColor="bg-green-500/20"
        />
        <StatsCard
          title="Failed"
          value={totalFailed.toLocaleString()}
          change={totalSent > 0 ? `${failRate}% fail rate` : undefined}
          changeType="negative"
          icon={AlertCircle}
          iconColor="text-amber-400"
          iconBgColor="bg-amber-500/20"
        />
        <StatsCard
          title="Complaints"
          value={totalComplaints.toLocaleString()}
          icon={AlertTriangle}
          iconColor="text-orange-400"
          iconBgColor="bg-orange-500/20"
        />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Campaign Status Breakdown */}
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold text-white flex items-center">
              <BarChart3 className="w-5 h-5 mr-2 text-indigo-400" />
              Campaign Status Breakdown
            </h2>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {statusBreakdown.map((item) => (
                <div key={item.status}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm text-gray-400">{item.status}</span>
                    <span className="text-sm font-medium text-white">{item.count}</span>
                  </div>
                  <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full ${item.color} rounded-full transition-all duration-500`}
                      style={{
                        width: `${totalCampaigns > 0 ? (item.count / totalCampaigns) * 100 : 0}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Performance Metrics */}
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold text-white flex items-center">
              <TrendingUp className="w-5 h-5 mr-2 text-green-400" />
              Performance Overview
            </h2>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              <div className="p-4 bg-gray-800/50 rounded-xl">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-gray-400">Delivery Rate</span>
                  <TrendingUp className="w-4 h-4 text-green-400" />
                </div>
                <p className="text-2xl font-bold text-green-400">{deliveryRate}%</p>
              </div>
              <div className="p-4 bg-gray-800/50 rounded-xl">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-gray-400">Fail Rate</span>
                  <AlertCircle className="w-4 h-4 text-amber-400" />
                </div>
                <p className="text-2xl font-bold text-amber-400">{failRate}%</p>
              </div>
              <div className="p-4 bg-gray-800/50 rounded-xl">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-gray-400">Active Campaigns</span>
                  <Mail className="w-4 h-4 text-yellow-400" />
                </div>
                <p className="text-2xl font-bold text-yellow-400">{activeCampaigns}</p>
              </div>
              <div className="p-4 bg-gray-800/50 rounded-xl">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-gray-400">Total Recipients</span>
                  <Mail className="w-4 h-4 text-blue-400" />
                </div>
                <p className="text-2xl font-bold text-blue-400">
                  {totalRecipients.toLocaleString()}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Top Campaigns */}
      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold text-white">Top Campaigns by Recipients</h2>
        </CardHeader>
        <CardContent>
          {campaigns.length > 0 ? (
            <div className="space-y-4">
              {[...campaigns]
                .sort((a, b) => (b.recieptCount || 0) - (a.recieptCount || 0))
                .slice(0, 5)
                .map((campaign, index) => (
                  <div
                    key={campaign.id}
                    className="flex items-center justify-between p-4 bg-gray-800/50 rounded-xl"
                  >
                    <div className="flex items-center space-x-4">
                      <div className="w-8 h-8 bg-gradient-to-br from-indigo-500 to-purple-500 rounded-lg flex items-center justify-center text-sm font-bold text-white">
                        {index + 1}
                      </div>
                      <div>
                        <p className="font-medium text-white">{campaign.name}</p>
                        <p className="text-sm text-gray-400">{campaign.subject}</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="font-semibold text-white">
                        {(campaign.recieptCount || 0).toLocaleString()}
                      </p>
                      <p className="text-sm text-gray-400">recipients</p>
                    </div>
                  </div>
                ))}
            </div>
          ) : (
            <div className="text-center py-8">
              <Mail className="w-12 h-12 text-gray-600 mx-auto mb-4" />
              <p className="text-gray-400">No campaigns to display</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
