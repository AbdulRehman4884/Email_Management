# Email Campaign Management System

A full-stack email marketing platform for creating, managing, and tracking email campaigns with real-time analytics and delivery status monitoring.

## Overview

This application provides a complete solution for managing email marketing campaigns. Users can create campaigns, upload recipient lists via CSV, schedule sends, and track detailed analytics including delivery rates, bounces, and complaints.

## Features

- **Campaign Management**: Create, edit, and manage email campaigns with scheduling support
- **Recipient Management**: Upload recipient lists via CSV with automatic suppression list filtering
- **Email Sending**: Asynchronous email processing using AWS SQS queue and worker system
- **Real-time Analytics**: Track sent, delivered, bounced, and complaint statistics
- **Webhook Integration**: AWS SNS webhooks for email delivery status updates
- **Dashboard**: Overview of all campaigns with aggregated statistics

## Technology Stack

### Backend
- **Runtime**: Bun
- **Framework**: Express.js
- **Language**: TypeScript
- **Database**: PostgreSQL
- **ORM**: Drizzle ORM
- **AWS Services**: 
  - SES (Simple Email Service) for sending emails
  - SQS (Simple Queue Service) for message queuing
  - SNS (Simple Notification Service) for webhooks
- **File Processing**: CSV parser with Multer

### Frontend
- **Framework**: React 19
- **Routing**: React Router DOM
- **State Management**: Zustand
- **HTTP Client**: Axios
- **UI Components**: Custom components with Lucide React icons
- **Build Tool**: Bun

## Project Structure

```
email-campaign/
├── backend/          # Express.js API server
│   ├── src/
│   │   ├── controllers/   # Request handlers
│   │   ├── routers/      # API routes
│   │   ├── workers/      # Email queue worker
│   │   ├── webhooks/     # AWS SNS webhook handlers
│   │   └── db/           # Database schema
│   └── drizzle/          # Database migrations
└── web/              # React frontend application
    └── src/
        ├── pages/        # Route pages
        ├── components/   # Reusable UI components
        ├── store/        # Zustand state management
        └── lib/          # API client utilities
```

## Getting Started

### Prerequisites
- Bun runtime installed
- PostgreSQL database
- AWS account with SES, SQS, and SNS configured

### Installation

1. **Backend Setup**
```bash
cd email-campaign/backend
bun install
```

2. **Frontend Setup**
```bash
cd email-campaign/web
bun install
```

### Environment Variables

Backend requires:
- Database connection string
- AWS credentials (region, access key, secret key)
- SQS queue URL
- SNS topic ARN

### Running the Application

**Backend:**
```bash
cd email-campaign/backend
bun run dev          # Development server
bun run worker       # Email worker (separate process)
```

**Frontend:**
```bash
cd email-campaign/web
bun dev
```

## Key Features Implementation

- **Queue-based Email Processing**: Emails are queued in SQS and processed by a dedicated worker with rate limiting
- **Template Variables**: Support for `{{firstName}}` and `{{email}}` in email content
- **Suppression List**: Automatic filtering of suppressed emails during CSV upload
- **Campaign Status Tracking**: Draft, scheduled, in_progress, paused, completed states
- **Real-time Stats**: Webhook-driven updates for delivery, bounce, and complaint events

---

## Contact

**LinkedIn**: [Hafiz Muhammad Hamza Noor](https://www.linkedin.com/in/hafiz-muhammad-hamza-noor-9304a82b8/)

**Email**: hamzach138446@gmail.com

