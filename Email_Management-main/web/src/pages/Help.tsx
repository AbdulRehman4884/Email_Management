import React from 'react';
import { Link } from 'react-router-dom';
import { Mail, Users, BarChart3, Settings, ArrowRight } from 'lucide-react';
import { Card, CardContent } from '../components/ui';

export function Help() {
  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Help & documentation</h1>
        <p className="text-gray-500 mt-1">
          Quick guide to campaigns, recipients, and tracking. Account and SMTP setup live in Settings.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="flex items-start gap-3 mb-3">
            <div className="p-2 bg-gray-100 rounded-lg flex-shrink-0">
              <Mail className="w-5 h-5 text-gray-600" />
            </div>
            <div>
              <h2 className="font-semibold text-gray-900">Creating campaigns</h2>
              <p className="text-sm text-gray-600 mt-1">
                Open <strong>Campaigns</strong>, choose <strong>Create campaign</strong>, set name and subject, compose your
                message (or use a template), and schedule or save as draft. Sender name and email come from your SMTP settings.
              </p>
              <Link
                to="/campaigns/create"
                className="inline-flex items-center text-sm text-blue-600 font-medium mt-3 hover:text-blue-700"
              >
                Create a campaign
                <ArrowRight className="w-3.5 h-3.5 ml-1" />
              </Link>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <div className="flex items-start gap-3 mb-3">
            <div className="p-2 bg-gray-100 rounded-lg flex-shrink-0">
              <Users className="w-5 h-5 text-gray-600" />
            </div>
            <div>
              <h2 className="font-semibold text-gray-900">Recipients & uploads</h2>
              <p className="text-sm text-gray-600 mt-1">
                While a campaign is in <strong>draft</strong>, open the campaign detail page and upload a CSV or Excel file
                with an <code className="text-xs bg-gray-100 px-1 rounded">email</code> column (optional{' '}
                <code className="text-xs bg-gray-100 px-1 rounded">name</code>). You can start sending once recipients are
                added and the campaign is ready.
              </p>
              <Link
                to="/campaigns"
                className="inline-flex items-center text-sm text-blue-600 font-medium mt-3 hover:text-blue-700"
              >
                View campaigns
                <ArrowRight className="w-3.5 h-3.5 ml-1" />
              </Link>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <div className="flex items-start gap-3 mb-3">
            <div className="p-2 bg-gray-100 rounded-lg flex-shrink-0">
              <BarChart3 className="w-5 h-5 text-gray-600" />
            </div>
            <div>
              <h2 className="font-semibold text-gray-900">Performance & tracking</h2>
              <p className="text-sm text-gray-600 mt-1">
                Use <strong>Analytics</strong> for aggregate opens, clicks, and trends. On each campaign you can see delivery
                stats and recipient status. Configure tracking base URL in Settings when your provider supports it.
              </p>
              <Link
                to="/analytics"
                className="inline-flex items-center text-sm text-blue-600 font-medium mt-3 hover:text-blue-700"
              >
                Open analytics
                <ArrowRight className="w-3.5 h-3.5 ml-1" />
              </Link>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <div className="flex items-start gap-3">
            <div className="p-2 bg-gray-100 rounded-lg flex-shrink-0">
              <Settings className="w-5 h-5 text-gray-600" />
            </div>
            <div>
              <h2 className="font-semibold text-gray-900">SMTP & account</h2>
              <p className="text-sm text-gray-600 mt-1">
                Connect your mail provider, set from name and email, and adjust sending preferences under Settings.
              </p>
              <Link
                to="/settings"
                className="inline-flex items-center text-sm text-blue-600 font-medium mt-3 hover:text-blue-700"
              >
                Open settings
                <ArrowRight className="w-3.5 h-3.5 ml-1" />
              </Link>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
