const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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

// المسار الرئيسي للبحث بإنشاء جلسة معزولة وخاصة بالطلب الحقيقي
app.post('/api/proxy-search', async (req, res) => {
    const { phoneNumber, captchaCode } = req.body;
    const config = getSettings();

    // 💡 إنشاء جلسة كوكيز جيدة تماماً وخاصة بهذا الطلب والزائر فقط
    const freshJar = new CookieJar();
    const isolatedClient = wrapper(axios.create({
        jar: freshJar,
        headers: config.headers || {},
        timeout: 15000,
        withCredentials: true
    }));

    // -------------------------------------------------------------
    // المرحلة 1: إذا لم يرسل الزائر كابتشا، نفتح جلسة جديدة ونجلب الصورة
    // -------------------------------------------------------------
    if (!captchaCode) {
        if (!config.captchaImgUrl) {
            return res.status(400).json({ success: false, message: 'لم يتم ضبط رابط الكابتشا في لوحة التحكم' });
        }

        try {
            console.log('--- بدء جلسة جديدة: جلب صورة الكابتشا ---');
            const imgRes = await isolatedClient.get(config.captchaImgUrl);
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
            return res.status(500).json({ 
                success: false, 
                message: 'خطأ في جلب صورة الكابتشا بالجلسة الجديدة',
                errorDetails: err.response ? err.response.data : err.message
            });
        }
    }

    // -------------------------------------------------------------
    // المرحلة 2: تنفيذ السلسلة كاملة بنفس الجلسة المعزولة
    // -------------------------------------------------------------
    try {
        // 1. إعادة توليد الجلسة لتجربة التمرير أو جلب صورة جديدة سريعاً لربط الكوكيز
        if (config.captchaImgUrl) {
            console.log('--- جلسة مستقلة: ربط الجلسة بطلب صورة أولاً ---');
            await isolatedClient.get(config.captchaImgUrl);
        }

        // 2. إرسال الكابتشا لمسار /i
        console.log('--- جلسة مستقلة: 1. التحقق من الكابتشا (/i) ---');
        const captchaFieldName = config.captchaField || 'captcha';
        const verifyPayload = { [captchaFieldName]: captchaCode };

        const verifyRes = await isolatedClient.post(config.verifyCaptchaUrl, verifyPayload, {
            headers: {
                'Content-Type': 'application/json',
                ...(config.headers || {})
            }
        });

        // طباعة الرد للتأكد
        console.log('رد مسار /i:', verifyRes.data);

        const isSuccess = verifyRes.data && (verifyRes.data.result === 'Success' || verifyRes.data.success === true);
        if (!isSuccess) {
            return res.json({
                success: false,
                message: 'رمز الكابتشا غير صحيح أو انتهت صلاحيته.',
                step: 'VERIFY_CAPTCHA_FAILED',
                originalResponse: verifyRes.data
            });
        }

        // 3. إنشاء طلب البحث /createRequest
        console.log('--- جلسة مستقلة: 2. إنشاء الطلب (/createRequest) ---');
        const createPayload = { [config.phoneField || 'phone']: phoneNumber };
        const createRes = await isolatedClient.post(config.createRequestUrl, createPayload);

        // 4. جلب التقرير /getreport
        console.log('--- جلسة مستقلة: 3. جلب التقرير (/getreport) ---');
        const reportPayload = { 
            [config.phoneField || 'phone']: phoneNumber,
            ...(createRes.data && typeof createRes.data === 'object' ? createRes.data : {})
        };
        const reportRes = await isolatedClient.post(config.getReportUrl, reportPayload);

        // إرجاع النتائج بنجاح
        return res.json({
            success: true,
            data: reportRes.data
        });

    } catch (err) {
        const status = err.response ? err.response.status : 'No Status';
        const errorData = err.response ? err.response.data : err.message;
        console.error(`خطأ الجلسة (${status}):`, errorData);

        return res.status(500).json({
            success: false,
            message: `فشل التنفيذ في الجلسة المخصصة (رمز: ${status})`,
            status: status,
            errorDetails: errorData
        });
    }
});

app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Mojz Server running on port ${PORT}`));
