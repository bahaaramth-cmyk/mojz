const express = require('express');
const axios = require('axios');
const path = require('path');
const cors = require('cors');
const https = require('https');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(express.static(__dirname));

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// الإعدادات الثابتة لاستعلامات موجز
const CONFIG = {
    captchaImgUrl: 'https://mojaz.com.sa/MojazWeb/captcha-controller/v2/captcha-image?',
    createRequestUrl: 'https://mojaz.com.sa/MojazWeb/api/requests/multiple/createRequest',
    phoneField: 'sequenceNumber',
    captchaField: 'jcaptcha'
};

// الذاكرة المؤقتة للزوار والإحصائيات
const activeSockets = new Map();
const visitorLogs = [];
let totalRequestsCount = 0;

// إدارة اتصالات اللوحة والزوار اللحظية عبر WebSockets
io.on('connection', (socket) => {
    socket.on('register_visitor', (userToken) => {
        activeSockets.set(socket.id, { token: userToken, time: new Date().toLocaleTimeString('ar-SA') });
        broadcastStats();
    });

    socket.on('disconnect', () => {
        activeSockets.delete(socket.id);
        broadcastStats();
    });
});

function broadcastStats() {
    const activeTokens = Array.from(new Set(Array.from(activeSockets.values()).map(s => s.token)));
    io.emit('dashboard_update', {
        onlineUsersCount: activeTokens.length,
        totalRequests: totalRequestsCount,
        visitorLogs: visitorLogs.slice(0, 50) // إرسال أحدث 50 عملية بحث للوحة
    });
}

function mergeAndDeduplicateCookies(cookieMap, setCookieHeader) {
    if (!setCookieHeader) return;
    const cookiesArray = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    cookiesArray.forEach(cookieStr => {
        const firstPart = cookieStr.split(';')[0].trim();
        const eqIdx = firstPart.indexOf('=');
        if (eqIdx !== -1) {
            cookieMap.set(firstPart.substring(0, eqIdx).trim(), firstPart.substring(eqIdx + 1).trim());
        }
    });
}

function buildCookieString(cookieMap) {
    const pairs = [];
    cookieMap.forEach((val, key) => pairs.push(`${key}=${val}`));
    return pairs.join('; ');
}

// وكيل الصور لتخطي حظر الشعار من سيرفر موجز
app.get('/api/image-proxy', async (req, res) => {
    try {
        const imageUrl = req.query.url;
        if (!imageUrl) return res.status(400).send('URL required');
        const response = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 
                'Referer': 'https://mojaz.com.sa/' 
            },
            httpsAgent: httpsAgent
        });
        res.set('Content-Type', response.headers['content-type'] || 'image/png');
        res.send(response.data);
    } catch (e) {
        res.status(404).send('Image not found');
    }
});

// استقبال طلبات الاستعلام
app.post('/api/proxy-search', async (req, res) => {
    const { phoneNumber, captchaCode, sessionCookie, captchaUuid, visitorToken } = req.body;
    const targetOrigin = 'https://mojaz.com.sa';

    const baseHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Origin': targetOrigin,
        'Referer': `${targetOrigin}/mojaz/`
    };

    // 1. طلب صورة الكابتشا
    if (!captchaCode) {
        try {
            const cookieMap = new Map();
            try {
                const mainPageRes = await axios.get(`${targetOrigin}/mojaz/`, { headers: baseHeaders, httpsAgent, timeout: 6000 });
                mergeAndDeduplicateCookies(cookieMap, mainPageRes.headers['set-cookie']);
            } catch (e) {}

            const initialCookieString = buildCookieString(cookieMap);
            const fullCaptchaUrl = `${CONFIG.captchaImgUrl}${Date.now()}`;

            const imgRes = await axios.get(fullCaptchaUrl, { 
                headers: { ...baseHeaders, ...(initialCookieString ? { 'Cookie': initialCookieString } : {}) },
                httpsAgent, timeout: 10000 
            });

            mergeAndDeduplicateCookies(cookieMap, imgRes.headers['set-cookie']);
            const finalSessionCookie = buildCookieString(cookieMap);

            let extractedUuid = imgRes.headers['captcha-uuid'] || imgRes.headers['captcha_uuid'] || '';
            let base64Image = imgRes.data.imageB64 || imgRes.data.captcha || imgRes.data;

            if (typeof base64Image === 'string' && !base64Image.startsWith('data:image')) {
                base64Image = `data:image/png;base64,${base64Image}`;
            }

            return res.json({ requireCaptcha: true, captchaImage: base64Image, sessionCookie: finalSessionCookie, captchaUuid: extractedUuid });
        } catch (err) {
            console.error("=== CAPTCHA FETCH ERROR ===", err.message);
            return res.status(500).json({ success: false, message: 'Failed to fetch captcha' });
        }
    }

    // 2. إرسال الكابتشا والرقم للبحث
    try {
        const mergedPayload = {
            [CONFIG.captchaField]: captchaCode,
            "vehicles": [{ [CONFIG.phoneField]: phoneNumber }],
            ...(captchaUuid ? { "captchaUuid": captchaUuid } : {})
        };

        const createRes = await axios.post(CONFIG.createRequestUrl, mergedPayload, {
            headers: { 
                ...baseHeaders, 
                'Content-Type': 'application/json', 
                'Cookie': sessionCookie || '',
                ...(captchaUuid ? { 'captcha-uuid': captchaUuid, 'x-captcha-uuid': captchaUuid } : {})
            },
            httpsAgent
        });

        // زيادة الإحصائيات وإخطار لوحة التحكم
        totalRequestsCount++;
        visitorLogs.unshift({
            id: Date.now(),
            token: visitorToken || 'GUEST-UNKNOWN',
            input: phoneNumber,
            time: new Date().toLocaleTimeString('ar-SA'),
            status: 'نجاح',
            resultData: createRes.data
        });
        broadcastStats();

        return res.json({ success: true, data: createRes.data });

    } catch (err) {
        totalRequestsCount++;
        
        // طباعة تفاصيل الخطأ المباشرة في لوغ Render
        const status = err.response ? err.response.status : 500;
        const errData = err.response ? err.response.data : err.message;
        
        console.error("=== MOJAZ API ERROR ===");
        console.error("Status:", status);
        console.error("Error Response Data:", JSON.stringify(errData, null, 2));
        console.error("=======================");

        visitorLogs.unshift({
            id: Date.now(),
            token: visitorToken || 'GUEST-UNKNOWN',
            input: phoneNumber,
            time: new Date().toLocaleTimeString('ar-SA'),
            status: `فشل (${status})`,
            resultData: errData
        });
        broadcastStats();

        return res.status(status).json({ 
            success: false, 
            message: (typeof errData === 'object' && errData.message) ? errData.message : 'فشل في جلب البيانات من الموقع الأصلي',
            errorDetails: errData 
        });
    }
});

// المسارات الخاصة بالموقع واللوحة
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server & Socket running on port ${PORT}`));
