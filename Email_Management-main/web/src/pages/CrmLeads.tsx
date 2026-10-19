import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';

/**
 * CRM step 5 had a separate Leads page here. Step 8 replaced it with the CRM dashboard (/crm), which has
 * the same filters, the cards, the drawer and bulk actions in its Table view. Old links such as
 * /crm/leads?campaignId=3&label=interested keep working: they open the dashboard table with the same filters.
 */
export function CrmLeads() {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  params.set('view', 'table');
  return <Navigate to={`/crm?${params.toString()}`} replace />;
}
