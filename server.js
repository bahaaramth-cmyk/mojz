// مسار البحث الذي يتعامل مع المرحلتين (قبل وبعد الكابتشا)
app.post('/api/proxy-search', async (req, res) => {
    const { phoneNumber, captchaCode, sessionData } = req.body;
    const config = getSettings();

    if (!config.targetUrl) {
        return res.status(400).json({ success: false, message: 'يرجى ضبط إعدادات الـ API أولاً' });
    }

    try {
        // تجهيز بيانات الطلب
        const payload = {
            [config.targetPhoneField]: phoneNumber
        };

        // إذا أرسل الزائر كود الكابتشا، نضيفه للطلب
        if (captchaCode) {
            payload[config.targetCaptchaField || 'captcha'] = captchaCode;
        }

        // إرسال الطلب للـ API الأصلي
        const response = await axios({
            method: config.method || 'POST',
            url: config.targetUrl,
            headers: config.headers || {},
            [config.method === 'GET' ? 'params' : 'data']: payload
        });

        // التحقق ممّا إذا كانت الاستجابة تطلب كابتشا (حسب بنية رد الموقع الأصلي)
        // ملاحظة: يمكنك تعديل الشرط أدناه ليتوافق مع رد الموقع الأصلي عند طلب الكابتشا
        if (response.data && (response.data.requireCaptcha || response.data.status === 'captcha_required')) {
            
            // جلب صورة الكابتشا فوراً
            let captchaBase64 = '';
            if (config.captchaUrl) {
                const imgRes = await axios.get(config.captchaUrl, {
                    headers: config.headers || {},
                    responseType: 'arraybuffer'
                });
                captchaBase64 = `data:${imgRes.headers['content-type'] || 'image/png'};base64,${Buffer.from(imgRes.data, 'binary').toString('base64')}`;
            }

            return res.json({
                success: false,
                requireCaptcha: true,
                captchaImage: captchaBase64,
                message: 'يرجى إدخال رمز الكابتشا للمتابعة'
            });
        }

        // إذا نجح البحث مباشرة وعادت البيانات
        res.json({ success: true, data: response.data });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'حدث خطأ أثناء التواصل مع الموقع الأصلي',
            errorDetails: error.response ? error.response.data : error.message
        });
    }
});
