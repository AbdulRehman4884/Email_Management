import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  Mail,
  Send,
  TrendingUp,
  Users,
  AlertTriangle,
  CheckCircle,
  ArrowRight,
  Plus,
} from 'lucide-react';
import { useCampaignStore } from '../store';
import { StatsCard, Button, Card, CardContent, StatusBadge, PageLoader } from '../components/ui';

export function Dashboard() {
  const { campaigns, isLoading, fetchCampaigns } = useCampaignStore();

  useEffect(() => {
    fetchCampaigns();
  }, [fetchCampaigns]);

  // Calculate dashboard stats from campaigns
  const totalCampaigns = campaigns.length;
  const activeCampaigns = campaigns.filter(
    (c) => c.status === 'in_progress' || c.status === 'scheduled'
  ).length;
  const totalRecipients = campaigns.reduce((sum, c) => sum + (c.recieptCount || 0), 0);
  const completedCampaigns = campaigns.filter((c) => c.status === 'completed').length;

  const recentCampaigns = [...campaigns]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 5);

  if (isLoading && campaigns.length === 0) {
    return <PageLoader />;
  }

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Dashboard</h1>
          <p className="text-gray-400 mt-1">
            Welcome back! Here's an overview of your campaigns.
          </p>
        </div>
        <Link to="/campaigns/create">
          <Button leftIcon={<Plus className="w-4 h-4" />}>New Campaign</Button>
        </Link>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatsCard
          title="Total Campaigns"
          value={totalCampaigns}
          icon={Mail}
          iconColor="text-indigo-400"
          iconBgColor="bg-indigo-500/20"
        />
        <StatsCard
          title="Active Campaigns"
          value={activeCampaigns}
          icon={Send}
          iconColor="text-green-400"
          iconBgColor="bg-green-500/20"
        />
        <StatsCard
          title="Total Recipients"
          value={totalRecipients.toLocaleString()}
          icon={Users}
          iconColor="text-blue-400"
          iconBgColor="bg-blue-500/20"
        />
        <StatsCard
          title="Completed"
          value={completedCampaigns}
          icon={CheckCircle}
          iconColor="text-purple-400"
          iconBgColor="bg-purple-500/20"
        />
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Performance Overview */}
        <Card className="lg:col-span-2">
          <CardContent>
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-semibold text-white">Recent Campaigns</h2>
              <Link
                to="/campaigns"
                className="text-sm text-indigo-400 hover:text-indigo-300 flex items-center"
              >
                View all
                <ArrowRight className="w-4 h-4 ml-1" />
              </Link>
            </div>

            {recentCampaigns.length > 0 ? (
              <div className="space-y-4">
                {recentCampaigns.map((campaign) => (
                  <Link
                    key={campaign.id}
                    to={`/campaigns/${campaign.id}`}
                    className="flex items-center justify-between p-4 bg-gray-800/50 rounded-xl hover:bg-gray-800 transition-colors group"
                  >
                    <div className="flex items-center space-x-4">
                      <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-purple-500 rounded-xl flex items-center justify-center">
                        <Mail className="w-5 h-5 text-white" />
                      </div>
                      <div>
                        <p className="font-medium text-white group-hover:text-indigo-400 transition-colors">
                          {campaign.name}
                        </p>
                        <p className="text-sm text-gray-400">
                          {campaign.recieptCount || 0} recipients
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center space-x-4">
                      <StatusBadge status={campaign.status} />
                      <ArrowRight className="w-5 h-5 text-gray-600 group-hover:text-gray-400 transition-colors" />
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="text-center py-12">
                <Mail className="w-12 h-12 text-gray-600 mx-auto mb-4" />
                <p className="text-gray-400 mb-4">No campaigns yet</p>
                <Link to="/campaigns/create">
                  <Button size="sm">Create your first campaign</Button>
                </Link>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Quick Actions */}
        <Card>
          <CardContent>
            <h2 className="text-lg font-semibold text-white mb-4">Quick Actions</h2>
            <div className="space-y-3">
              <Link
                to="/campaigns/create"
                className="flex items-center p-4 bg-gradient-to-r from-indigo-500/10 to-purple-500/10 border border-indigo-500/20 rounded-xl hover:border-indigo-500/40 transition-colors group"
              >
                <div className="w-10 h-10 bg-indigo-500/20 rounded-xl flex items-center justify-center mr-4">
                  <Plus className="w-5 h-5 text-indigo-400" />
                </div>
                <div>
                  <p className="font-medium text-white group-hover:text-indigo-400 transition-colors">
                    Create Campaign
                  </p>
                  <p className="text-sm text-gray-400">Start a new email campaign</p>
                </div>
              </Link>

              <Link
                to="/campaigns"
                className="flex items-center p-4 bg-gray-800/50 rounded-xl hover:bg-gray-800 transition-colors group"
              >
                <div className="w-10 h-10 bg-gray-700 rounded-xl flex items-center justify-center mr-4">
                  <Mail className="w-5 h-5 text-gray-400" />
                </div>
                <div>
                  <p className="font-medium text-white group-hover:text-indigo-400 transition-colors">
                    View Campaigns
                  </p>
                  <p className="text-sm text-gray-400">Manage all campaigns</p>
                </div>
              </Link>

              <Link
                to="/analytics"
                className="flex items-center p-4 bg-gray-800/50 rounded-xl hover:bg-gray-800 transition-colors group"
              >
                <div className="w-10 h-10 bg-gray-700 rounded-xl flex items-center justify-center mr-4">
                  <TrendingUp className="w-5 h-5 text-gray-400" />
                </div>
                <div>
                  <p className="font-medium text-white group-hover:text-indigo-400 transition-colors">
                    Analytics
                  </p>
                  <p className="text-sm text-gray-400">View performance metrics</p>
                </div>
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tips Section */}
      <Card>
        <CardContent>
          <div className="flex items-start space-x-4">
            <div className="w-12 h-12 bg-yellow-500/20 rounded-xl flex items-center justify-center flex-shrink-0">
              <AlertTriangle className="w-6 h-6 text-yellow-400" />
            </div>
            <div>
              <h3 className="font-semibold text-white mb-1">Pro Tips</h3>
              <ul className="text-sm text-gray-400 space-y-1">
                <li>• Always test your email content before sending to your entire list</li>
                <li>• Monitor your bounce and complaint rates to maintain good deliverability</li>
                <li>• Use personalization tokens like {"{{firstName}}"} to increase engagement</li>
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
