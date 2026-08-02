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
    const { phoneNumber, captchaCode, sessionCookie } = req.body;
    const config = getSettings();

    // -------------------------------------------------------------
    // المرحلة 1: جلب صورة الكابتشا باستخدام رابط ديناميكي متجدد
    // -------------------------------------------------------------
    if (!captchaCode) {
        if (!config.captchaImgUrl) {
            return res.status(400).json({ success: false, message: 'يرجى ضبط رابط الكابتشا في لوحة التحكم أولاً' });
        }

        try {
            // إضافة مُميّز زمني (Timestamp) للرابط لمنع الكاش ولضمان توليد رابط ديناميكي جديد
            const dynamicCaptchaUrl = config.captchaImgUrl.includes('?') 
                ? `${config.captchaImgUrl}&_t=${Date.now()}` 
                : `${config.captchaImgUrl}?_t=${Date.now()}`;

            console.log('--- جلب الكابتشا برابط ديناميكي:', dynamicCaptchaUrl);
            
            const imgRes = await axios.get(dynamicCaptchaUrl, {
                headers: config.headers || {}
            });

            // استخراج الكوكيز الخاصة بهذه الجلسة تحديداً
            const setCookieHeader = imgRes.headers['set-cookie'];
            const originalCookie = setCookieHeader ? setCookieHeader.join('; ') : '';

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
                captchaImage: base64Image,
                sessionCookie: originalCookie
            });

        } catch (err) {
            console.error('خطأ الكابتشا الديناميكية:', err.message);
            return res.status(500).json({ 
                success: false, 
                message: 'فشل جلب صورة الكابتشا الديناميكية',
                errorDetails: err.response ? err.response.data : err.message
            });
        }
    }

    // -------------------------------------------------------------
    // المرحلة 2: مرونة التنفيذ (محاولة التحقق أو التجاوز التلقائي)
    // -------------------------------------------------------------
    try {
        const captchaFieldName = config.captchaField || 'captcha';
        const phoneFieldName = config.phoneField || 'phone';

        const reqHeaders = {
            ...(config.headers || {}),
            ...(sessionCookie ? { 'Cookie': sessionCookie } : {})
        };

        // الخطوة A: تجربة إرسال الكابتشا إلى /i (إن وجدت)
        if (config.verifyCaptchaUrl) {
            console.log('--- 1. تجربة التحقق من الكابتشا عبر /i ---');
            try {
                const verifyPayload = { [captchaFieldName]: captchaCode };
                const verifyRes = await axios.post(config.verifyCaptchaUrl, verifyPayload, { headers: reqHeaders });
                console.log('استجابة مسار /i:', verifyRes.data);
            } catch (vErr) {
                console.log('تنبيه: تم تجاوز مسار /i أو لم يطلب السيرفر التحقق المباشر منه.');
            }
        }

        // الخطوة B: إنشاء طلب البحث مباشرة عبر /createRequest
        console.log('--- 2. إنشاء طلب البحث (/createRequest) ---');
        const createPayload = { 
            [phoneFieldName]: phoneNumber,
            [captchaFieldName]: captchaCode // نرفق الكابتشا هنا أيضاً تحسباً
        };
        const createRes = await axios.post(config.createRequestUrl, createPayload, { headers: reqHeaders });

        // الخطوة C: جلب التقرير /getreport
        console.log('--- 3. جلب التقرير والنتائج (/getreport) ---');
        const reportPayload = { 
            [phoneFieldName]: phoneNumber,
            ...(createRes.data && typeof createRes.data === 'object' ? createRes.data : {})
        };
        const reportRes = await axios.post(config.getReportUrl, reportPayload, { headers: reqHeaders });

        return res.json({
            success: true,
            data: reportRes.data
        });

    } catch (err) {
        const status = err.response ? err.response.status : 'No Response';
        const responseData = err.response ? err.response.data : err.message;
        
        console.error(`خطأ تنفيذ السلسلة (${status}):`, responseData);

        return res.status(status === 'No Response' ? 500 : status).json({
            success: false,
            message: `فشل طلب السلسلة عند خطوة جلب البيانات (رمز: ${status})`,
            status: status,
            errorDetails: responseData
        });
    }
});

app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Mojz Server running on port ${PORT}`));
