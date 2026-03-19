import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  Mail,
  Send,
  Users,
  CheckCircle,
  ArrowRight,
  BarChart3,
  BookOpen,
} from 'lucide-react';
import { useCampaignStore } from '../store';
import { StatsCard, Button, Card, CardContent, StatusBadge, PageLoader } from '../components/ui';

export function Dashboard() {
  const { campaigns, isLoading, fetchCampaigns } = useCampaignStore();

  useEffect(() => {
    fetchCampaigns();
  }, [fetchCampaigns]);

  const totalCampaigns = campaigns.length;
  const activeCampaigns = campaigns.filter(
    (c) => c.status === 'in_progress' || c.status === 'scheduled'
  ).length;
  const totalRecipients = campaigns.reduce((sum, c) => sum + (c.recieptCount || 0), 0);
  const completedCampaigns = campaigns.filter((c) => c.status === 'completed').length;

  const recentCampaigns = [...campaigns]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 4);

  if (isLoading && campaigns.length === 0) {
    return <PageLoader />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-gray-500 mt-1">Campaign performance at a glance.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatsCard
          title="Total Campaigns"
          value={totalCampaigns}
          icon={Send}
          iconColor="text-gray-400"
          iconBgColor="bg-gray-50"
        />
        <StatsCard
          title="Active Campaigns"
          value={activeCampaigns}
          change={activeCampaigns > 0 ? `+${activeCampaigns}` : undefined}
          changeType="positive"
          icon={Send}
          iconColor="text-green-500"
          iconBgColor="bg-green-50"
        />
        <StatsCard
          title="Total Recipients"
          value={totalRecipients.toLocaleString()}
          icon={Users}
          iconColor="text-gray-400"
          iconBgColor="bg-gray-50"
        />
        <StatsCard
          title="Completed"
          value={completedCampaigns}
          icon={CheckCircle}
          iconColor="text-gray-400"
          iconBgColor="bg-gray-50"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardContent>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-gray-900">Recent campaigns</h2>
              <Link
                to="/campaigns"
                className="text-sm text-blue-600 hover:text-blue-700 flex items-center font-medium"
              >
                View all
                <ArrowRight className="w-3.5 h-3.5 ml-1" />
              </Link>
            </div>

            {recentCampaigns.length > 0 ? (
              <div className="divide-y divide-gray-100">
                {recentCampaigns.map((campaign) => (
                  <Link
                    key={campaign.id}
                    to={`/campaigns/${campaign.id}`}
                    className="flex items-center justify-between py-3 hover:bg-gray-50 -mx-2 px-2 rounded-lg transition-colors"
                  >
                    <div>
                      <p className="font-medium text-gray-900 text-sm">{campaign.name}</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {(campaign.recieptCount || 0).toLocaleString()} recipients
                      </p>
                    </div>
                    <StatusBadge status={campaign.status} />
                  </Link>
                ))}
              </div>
            ) : (
              <div className="text-center py-8">
                <Mail className="w-10 h-10 text-gray-300 mx-auto mb-3" />
                <p className="text-gray-500 text-sm mb-3">No campaigns yet</p>
                <Link to="/campaigns/create">
                  <Button size="sm">Create your first campaign</Button>
                </Link>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardContent>
              <h2 className="text-base font-semibold text-gray-900 mb-4">Quick actions</h2>
              <div className="space-y-2">
                <Link to="/campaigns/create" className="block">
                  <Button className="w-full justify-start">
                    <Mail className="w-4 h-4 mr-2" />
                    Create campaign
                  </Button>
                </Link>
                <Link
                  to="/campaigns"
                  className="flex items-center px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-lg transition-colors"
                >
                  <Send className="w-4 h-4 mr-2 text-gray-400" />
                  View campaigns
                </Link>
                <Link
                  to="/analytics"
                  className="flex items-center px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-lg transition-colors"
                >
                  <BarChart3 className="w-4 h-4 mr-2 text-gray-400" />
                  Analytics
                </Link>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent>
              <div className="flex items-start gap-3">
                <div className="p-2 bg-gray-100 rounded-lg flex-shrink-0">
                  <BookOpen className="w-5 h-5 text-gray-600" />
                </div>
                <div>
                  <h3 className="font-semibold text-gray-900 text-sm">Help & Docs</h3>
                  <p className="text-xs text-gray-500 mt-1">
                    Learn how to create effective campaigns, manage recipients, and track performance.
                  </p>
                  <a href="#" className="text-xs text-blue-600 font-medium mt-2 inline-block hover:text-blue-700">
                    Read the guide
                  </a>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
