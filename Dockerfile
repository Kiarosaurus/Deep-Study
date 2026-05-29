FROM python:3.12-slim

# Surya / Marker pull in image-processing libs that link against libGL and
# glib at runtime; the slim base ships neither.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first so app-code changes don't bust the (large)
# torch / marker-pdf layer.
COPY requirements.txt ./
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r requirements.txt

COPY . .

# uploads/ is the on-disk store for PDFs + their *.analysis.json siblings.
# It's bind-mounted from the host in compose so files survive `down`.
RUN mkdir -p /app/uploads

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
