-- Undo migration 0037 (CRM step 10). Removes only the website tracking and form tables.
-- All tracked visits, forms and form submissions are lost. Leads, campaigns and replies are not touched.
DROP TABLE IF EXISTS crm_form_submissions;
DROP TABLE IF EXISTS crm_forms;
DROP TABLE IF EXISTS crm_web_pageviews;
DROP TABLE IF EXISTS crm_web_visitors;
DROP TABLE IF EXISTS crm_sites;
