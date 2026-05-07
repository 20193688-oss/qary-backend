// Variables de entorno de prueba (antes de importar nada del backend)
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
process.env.HMAC_SECRET = 'test-hmac-secret';
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_dummy';
process.env.AGENT_VOICE_PIN_REQUIRED = 'true';
process.env.LOG_LEVEL = 'silent';
process.env.BCRYPT_ROUNDS = '4'; // tests más rápidos
