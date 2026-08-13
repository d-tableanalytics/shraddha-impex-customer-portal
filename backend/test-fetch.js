import http from 'http';

function request(options, data) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(body) }));
    });
    req.on('error', reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

async function test() {
  try {
    const login = await request({
      hostname: 'localhost',
      port: 5000,
      path: '/api/v1/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      email: process.env.TEST_EMAIL || 'angelsharmajiya@gmail.com',
      password: process.env.TEST_PASSWORD || 'a1234'
    });
    
    const token = login.data.token;
    
    const res = await request({
      hostname: 'localhost',
      port: 5000,
      path: '/api/v1/products/koken',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    console.log(res.data);
  } catch (err) {
    console.error(err);
  }
}
test();
