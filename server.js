const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

const app = express();
app.use(express.json());
app.use(cors());

const CONFIG_PATH = path.join(__dirname, 'config.json');

function getSettings() {
    if (!fs.existsSync(CONFIG_PATH)) {
        return { 
            captchaImgUrl: '', 
            verifyCaptchaUrl: '', 
            createRequestUrl: '', 
            getReportUrl: '', 
            phoneField: 'phone',
            captchaField: 'captcha',
            headers: {} 
        };
    }
    try {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
        return { captchaImgUrl: '', verifyCaptchaUrl: '', createRequestUrl: '', getReportUrl: '', phoneField: 'phone', captchaField: 'captcha', headers: {} };
    }
}

app.get('/api/settings', (req, res) => res.json(getSettings()));

app.post('/api/settings', (req, res) => {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(req.body, null, 2));
        res.json({ success: true, message: 'تم حفظ الإعدادات بنجاح' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'فشل حفظ الإعدادات' });
    }
});

app.post('/api/proxy-search', async (req, res) => {
    const { phoneNumber, captchaCode } = req.body;
    const config = getSettings();

    // إنشاء CookieJar للربط التلقائي للكوكيز بين كافة الطلبات
    const jar = new CookieJar();
    const client = wrapper(axios.create({
        jar,
        headers: config.headers || {},
        timeout: 15000,
        withCredentials: true
    }));

    try {
        // 1. جلب صورة الكابتشا
        if (!captchaCode) {
            if (!config.captchaImgUrl) {
                return res.status(400).json({ success: false, message: 'يرجى ضبط رابط الكابتشا في لوحة التحكم أولاً' });
            }

            try {
                const imgRes = await client.get(config.captchaImgUrl);
                let base64Image = '';

                if (typeof imgRes.data === 'object' && imgRes.data !== null) {
                    base64Image = imgRes.data.imageB64 || imgRes.data.captcha || imgRes.data.image || '';
                } else if (typeof imgRes.data === 'string') {
                    try {
                        const parsed = JSON.parse(imgRes.data);
                        base64Image = parsed.imageB64 || parsed.captcha || parsed.image || '';
                    } catch (e) {
                        base64Image = imgRes.data;
                    }
                }

                if (base64Image && !base64Image.startsWith('data:image')) {
                    base64Image = `data:image/png;base64,${base64Image}`;
                }

                return res.json({
                    success: false,
                    requireCaptcha: true,
                    captchaImage: base64Image
                });

            } catch (err) {
                console.error('خطأ الكابتشا:', err.message);
                return res.status(500).json({ success: false, message: 'فشل جلب صورة الكابتشا' });
            }
        }

        // 2. خطوة التحقق من الكابتشا (POST /i)
        console.log('1. إرسال الكابتشا للتحقق...');
        const verifyPayload = { [config.captchaField || 'captcha']: captchaCode };
        const verifyRes = await client.post(config.verifyCaptchaUrl, verifyPayload);

        // 3. خطوة إنشاء الطلب (POST /createRequest)
        console.log('2. إنشاء طلب البحث...');
        const createPayload = { [config.phoneField || 'phone']: phoneNumber };
        const createRes = await client.post(config.createRequestUrl, createPayload);

        // 4. خطوة جلب التقرير (POST /getreport)
        console.log('3. جلب التقرير والنتائج...');
        const reportPayload = { 
            [config.phoneField || 'phone']: phoneNumber,
            ...(createRes.data && typeof createRes.data === 'object' ? createRes.data : {})
        };
        const reportRes = await client.post(config.getReportUrl, reportPayload);

        res.json({
            success: true,
            data: reportRes.data
        });

    } catch (error) {
        console.error('تفاصيل الخطأ أثناء السلسلة:', error.response ? error.response.data : error.message);
        res.status(500).json({
            success: false,
            message: 'حدث خطأ أثناء الاتصال بالموقع الأصلي',
            errorDetails: error.response ? error.response.data : error.message
        });
    }
});

app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Mojz Server running on port ${PORT}`));
