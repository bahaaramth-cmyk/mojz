const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const CONFIG_PATH = path.join(__dirname, 'config.json');

function getSettings() {
    if (!fs.existsSync(CONFIG_PATH)) {
        return { targetUrl: '', captchaUrl: '', method: 'POST', targetPhoneField: 'phone', targetCaptchaField: 'captcha', headers: {} };
    }
    try {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
        return { targetUrl: '', captchaUrl: '', method: 'POST', targetPhoneField: 'phone', targetCaptchaField: 'captcha', headers: {} };
    }
}

// 1. مسارات لوحة التحكم
app.get('/api/settings', (req, res) => res.json(getSettings()));

app.post('/api/settings', (req, res) => {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(req.body, null, 2));
        res.json({ success: true, message: 'تم حفظ الإعدادات' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'فشل الحفظ' });
    }
});

// 2. مسار جلب صورة الكابتشا وترحيلها كـ Base64
app.get('/api/get-captcha', async (req, res) => {
    const config = getSettings();
    if (!config.captchaUrl) {
        return res.status(400).json({ success: false, message: 'لم يتم تحديد رابط الكابتشا في لوحة التحكم' });
    }

    try {
        // جلب صورة الكابتشا من الموقع الأصلي كـ ArrayBuffer
        const response = await axios.get(config.captchaUrl, {
            headers: config.headers || {},
            responseType: 'arraybuffer'
        });

        // تحويل الصورة إلى صيغة Base64 لعرضها مباشرة في الموقع التجريبي
        const base64Image = Buffer.from(response.data, 'binary').toString('base64');
        const mimeType = response.headers['content-type'] || 'image/png';

        res.json({
            success: true,
            captchaImage: `data:${mimeType};base64,${base64Image}`
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'فشل جلب الكابتشا من الموقع الأصلي' });
    }
});

// 3. مسار البحث الممرّر (مع الكابتشا)
app.post('/api/proxy-search', async (req, res) => {
    const { phoneNumber, captchaCode } = req.body;
    const config = getSettings();

    if (!config.targetUrl) {
        return res.status(400).json({ success: false, message: 'يرجى ضبط الإعدادات أولاً' });
    }

    try {
        // بناء الـ Payload ديناميكياً ليشمل حقل الهاتف وحقل الكابتشا
        const payload = {
            [config.targetPhoneField]: phoneNumber,
            [config.targetCaptchaField || 'captcha']: captchaCode
        };

        const response = await axios({
            method: config.method || 'POST',
            url: config.targetUrl,
            headers: config.headers || {},
            [config.method === 'GET' ? 'params' : 'data']: payload
        });

        res.json({ success: true, data: response.data });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'خطأ أثناء إرسال الطلب',
            errorDetails: error.response ? error.response.data : error.message
        });
    }
});

app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/', (req, res) => res.send('Server Running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
