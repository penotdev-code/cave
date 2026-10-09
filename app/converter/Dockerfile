# Convertisseur DWG → plan (service interne, appelé par l'application)
# LibreDWG (GNU, compilé depuis les sources officielles) + ezdxf + shapely.
FROM debian:13-slim AS build
RUN apt-get update -q && apt-get install -yq --no-install-recommends build-essential curl ca-certificates xz-utils python3 \
 && rm -rf /var/lib/apt/lists/*
ARG LIBREDWG=0.13.3
RUN curl -fsSL https://ftp.gnu.org/gnu/libredwg/libredwg-${LIBREDWG}.tar.xz -o /tmp/l.tar.xz \
 && cd /tmp && tar xf l.tar.xz && cd libredwg-${LIBREDWG} \
 && ./configure --prefix=/opt/libredwg --disable-bindings --disable-docs --quiet \
 && make -j"$(nproc)" >/dev/null && make install >/dev/null

FROM debian:13-slim
RUN apt-get update -q && apt-get install -yq --no-install-recommends python3 python3-venv fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /opt/libredwg /opt/libredwg
ENV PATH=/opt/libredwg/bin:$PATH LD_LIBRARY_PATH=/opt/libredwg/lib
RUN python3 -m venv /venv && /venv/bin/pip install -q --no-cache-dir ezdxf==1.4.4 shapely==2.2.0 openpyxl==3.1.5
WORKDIR /app
COPY dwg2plan.py service.py ./
RUN useradd -r -u 10001 conv
USER conv
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD python3 -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/sante')" || exit 1
CMD ["/venv/bin/python", "service.py"]
