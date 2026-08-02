const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const CONFIG_PATH = path.join(__dirname, 'config.json');

// دالة جلب الإعدادات الحالية
function getSettings() {
    if (!fs.existsSync(CONFIG_PATH)) {
        return { targetUrl: '', method: 'POST', targetPhoneField: 'phone', headers: {} };
    }
    try {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
        return { targetUrl: '', method: 'POST', targetPhoneField: 'phone', headers: {} };
    }
}

// 1. مسار جلب الإعدادات للوحة التحكم
app.get('/api/settings', (req, res) => {
    res.json(getSettings());
});

// 2. مسار حفظ الإعدادات من لوحة التحكم
app.post('/api/settings', (req, res) => {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(req.body, null, 2));
        res.json({ success: true, message: 'تم حفظ الإعدادات بنجاح' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'فشل حفظ الإعدادات' });
    }
});

// 3. مسار البحث اللحظي (Proxy Search)
app.post('/api/proxy-search', async (req, res) => {
    const { phoneNumber, captchaCode } = req.body;
    const config = getSettings();

    if (!config.targetUrl) {
        return res.status(400).json({ success: false, message: 'يرجى ضبط إعدادات الـ API من لوحة التحكم أولاً.' });
    }

    try {
        // تجهيز بيانات الطلب للموقع الأصلي
        const payload = {
            [config.targetPhoneField]: phoneNumber
        };
        if (captchaCode) payload['captcha'] = captchaCode;

        // إرسال الطلب للموقع الأصلي
        const response = await axios({
            method: config.method || 'POST',
            url: config.targetUrl,
            headers: config.headers || {},
            [config.method === 'GET' ? 'params' : 'data']: payload
        });

        // إرجاع النتائج للموقع التجريبي
        res.json({ success: true, data: response.data });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'حدث خطأ أثناء الاتصال بالموقع الأصلي',
            errorDetails: error.response ? error.response.data : error.message
        });
    }
});

// تقديم صفحة لوحة التحكم
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// المسار الرئيسي
app.get('/', (req, res) => {
    res.send('Mojz API Proxy Server is Running. Go to /dashboard for control panel.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});