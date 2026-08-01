import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { errorHandler } from './middlewares/errorHandler.js';

// Route imports
import authRoutes from './modules/auth/auth.routes.js';
import userRoutes from './modules/users/user.routes.js';
import productRoutes, { inventoryRouter } from './modules/products/product.routes.js';
import orderRoutes from './modules/orders/order.routes.js';
import reservationRoutes from './modules/reservations/reservation.routes.js';
import notificationRoutes from './modules/notifications/notification.routes.js';
import roleRoutes from './modules/roles/role.routes.js';
import salesRoutes from './modules/sales/sales.routes.js';
import inventoryRoutes from './modules/inventory/inventory.routes.js';
import apiRoutes from './routes/api.routes.js';

const app = express();

// Behind a hosting proxy/load balancer, req.ip is the proxy's address unless we
// trust the X-Forwarded-For header. Without this every user shares one identity,
// so anything keyed on IP (the login brute-force guard) would count the whole
// userbase as a single client.
app.set('trust proxy', 1);

// Middleware
app.use(helmet());

const allowedOrigins = process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : ['http://localhost:5173'];
app.use(cors({ 
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }, 
  credentials: true 
}));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('dev'));
}

// Routes
// Rate limiting is intentionally absent: a single page load costs several
// requests, and any per-IP ceiling tight enough to matter locked real users out
// mid-task. Nothing throttles /api, including the login and register endpoints.
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/products', inventoryRouter);
app.use('/api/v1/products/:brand', productRoutes);
app.use('/api/v1/orders', orderRoutes);
app.use('/api/v1/reservations', reservationRoutes);
app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1/roles', roleRoutes);
app.use('/api/v1/sales', salesRoutes);
// Inventory Management System (M1: master, locations, configuration).
app.use('/api/v1/inventory', inventoryRoutes);
app.use('/api', apiRoutes);
app.use('/api/v1', apiRoutes); // also serve under /api/v1 so frontend api.get('/dashboard/stats') resolves

// Health Check
app.get('/health', (req, res) => {
  res.status(200).json({ success: true, message: 'ERP Backend is running.' });
});

// 404 Handler
app.use((req, res, next) => {
  res.status(404).json({ success: false, message: 'API Route Not Found' });
});

// Global Error Handler
app.use(errorHandler);

export default app;
