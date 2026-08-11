# Shraddha Impex ERP - Backend

This is the backend API service for the Shraddha Impex ERP and Customer Portal. It provides a secure, role-based RESTful API using Node.js, Express, and MongoDB.

## Features

- **Authentication Module**: Secure JWT-based registration and login system.
- **User Management**: Endpoints to list all users and manage their statuses.
- **Role-Based Access Control (RBAC)**: Advanced permission system supporting dynamic creation of roles (e.g., Administrator, Sales Manager) and granular permission arrays (e.g., `['manage_orders', 'manage_inventory']`).
- **Data Migration System**: Includes robust `migrate.js` script to migrate and map data seamlessly from Excel files (Koken, BIX, IMADA) to MongoDB.
- **Temporary Reservations Module**: Handles cart reservations and stock blocking with automatic expirations before final PO conversion.
- **Email Notifications**: Integrated `mailer.js` utility for sending automated notifications across workflows.
- **Automatic Seeding**: The server automatically seeds essential enterprise roles into the database on startup if none exist.
- **Real-Time Sockets**: Integrated `socket.io` for real-time notifications and updates to connected clients.
- **Security**: Error handling middleware, payload validation, and CORS support.

## Tech Stack

- **Node.js** & **Express.js**
- **MongoDB** & **Mongoose** (Database & ODM)
- **JSON Web Tokens (JWT)** (Authentication)
- **Bcrypt.js** (Password hashing)
- **Socket.io** (WebSockets)
- **Dotenv** (Environment management)

## Getting Started

### Prerequisites
- Node.js (v16+)
- MongoDB (running locally on port 27017 or a MongoDB Atlas URI)

### Installation

1. Navigate to the `backend/` directory.
2. Install dependencies:
   ```bash
   npm install
   ```

### Configuration

Create a `.env` file in the root of the `backend/` directory if it doesn't already exist:

```env
PORT=5000
MONGODB_URI=mongodb://localhost:27017/erp_portal
JWT_SECRET=super_secret_enterprise_jwt_key_2026
JWT_EXPIRES_IN=1d
NODE_ENV=development

# Mail
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
EMAIL_FROM="Shraddha Impex Booking Portal" <no-reply@example.com>

# Notification recipients (comma-separated)
BOOKING_CC_EMAILS=Contact@shraddhaimpex.net
SUPPORT_TEAM_EMAILS=support@shraddhaimpex.net
```
*(Note: Change `JWT_SECRET` in production to a secure random hash).*

**`SMTP_HOST` is not optional.** With it unset the mailer logs every message to
the console instead of sending it, and reports success — an app started without
its `.env` therefore reports every notification as delivered while sending none.

**`SUPPORT_TEAM_EMAILS`** is the Support Team mailbox. It receives its own copy —
not a Cc — of every indent raised, every booking confirmed, and every material
inward posted against an open indent. Left unset it falls back to
`BOOKING_CC_EMAILS`, so support still hears about these events; set it explicitly
to route them at a real support queue. Set it to an empty string to disable the
support copy entirely.

### Running the Server

Start the backend development server using nodemon:
```bash
npm run dev
```
Alternatively, run the server without nodemon:
```bash
npm start
```

The server will start on `http://localhost:5000` (or the port defined in your `.env`).

## API Structure

- `server.js`: Application entry point and Socket.io initialization.
- `app.js`: Express configuration, middleware setup, and route aggregation.
- `config/`: Database connection (`database.js`) and startup seeders (`seedRoles.js`).
- `middlewares/`: Security middlewares (e.g., `auth.js` for JWT verification).
- `models/`: Mongoose schemas (`User.js`, `Role.js`).
- `modules/`: Feature-based directory containing controllers and route definitions for specific domains (e.g., `auth/`, `users/`, `roles/`).
