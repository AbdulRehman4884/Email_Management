import React, { useEffect } from 'react';
import {
  BarChart3,
  TrendingUp,
  TrendingDown,
  Mail,
  Send,
  CheckCircle,
  XCircle,
  AlertTriangle,
} from 'lucide-react';
import { useCampaignStore } from '../store';
import { Card, CardContent, CardHeader, StatsCard, PageLoader } from '../components/ui';

export function Analytics() {
  const { campaigns, isLoading, fetchCampaigns } = useCampaignStore();

  useEffect(() => {
    fetchCampaigns();
  }, [fetchCampaigns]);

  // Calculate aggregate stats
  const totalCampaigns = campaigns.length;
  const completedCampaigns = campaigns.filter((c) => c.status === 'completed').length;
  const activeCampaigns = campaigns.filter(
    (c) => c.status === 'in_progress' || c.status === 'scheduled'
  ).length;
  const totalRecipients = campaigns.reduce((sum, c) => sum + (c.recieptCount || 0), 0);

  // Mock data for demonstration (in real app, this would come from aggregated stats)
  const mockStats = {
    totalSent: Math.floor(totalRecipients * 0.85),
    totalDelivered: Math.floor(totalRecipients * 0.82),
    totalBounced: Math.floor(totalRecipients * 0.02),
    totalFailed: Math.floor(totalRecipients * 0.01),
    totalComplaints: Math.floor(totalRecipients * 0.001),
  };

  const deliveryRate = totalRecipients > 0 
    ? Math.round((mockStats.totalDelivered / mockStats.totalSent) * 100) 
    : 0;
  const bounceRate = totalRecipients > 0 
    ? ((mockStats.totalBounced / mockStats.totalSent) * 100).toFixed(2) 
    : 0;

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

      {/* Main Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatsCard
          title="Total Emails Sent"
          value={mockStats.totalSent.toLocaleString()}
          icon={Send}
          iconColor="text-indigo-400"
          iconBgColor="bg-indigo-500/20"
        />
        <StatsCard
          title="Delivered"
          value={mockStats.totalDelivered.toLocaleString()}
          change={`${deliveryRate}% delivery rate`}
          changeType="positive"
          icon={CheckCircle}
          iconColor="text-green-400"
          iconBgColor="bg-green-500/20"
        />
        <StatsCard
          title="Bounced"
          value={mockStats.totalBounced.toLocaleString()}
          change={`${bounceRate}% bounce rate`}
          changeType="negative"
          icon={XCircle}
          iconColor="text-red-400"
          iconBgColor="bg-red-500/20"
        />
        <StatsCard
          title="Complaints"
          value={mockStats.totalComplaints.toLocaleString()}
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
                  <span className="text-sm text-gray-400">Bounce Rate</span>
                  <TrendingDown className="w-4 h-4 text-red-400" />
                </div>
                <p className="text-2xl font-bold text-red-400">{bounceRate}%</p>
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
