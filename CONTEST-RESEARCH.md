# Mosaide + HYROS: propuesta para ambos concursos

Fecha: 2026-09-23. Documento de analisis, no implementacion.

## Recomendacion

Construir una experiencia que ayude a decidir que anuncio escalar, revisar o mantener en observacion, con evidencia que el operador pueda comprobar. Mostrarla con dos negocios: ventas por llamada e ecommerce.

Presentar dos entregables relacionados:

- Vibe: modulos integrados en este template, con recomendaciones, modelos comparables y drill-down hasta la evidencia.
- MCP: un proceso reproducible en Mosaide que consulte HYROS, investigue una decision y produzca un informe verificable. Publicar los prompts, llamadas, criterios y feedback.

Reutilizar las funciones de negocio y sus pruebas de Mosaide. Adaptar las vistas al sistema de features de AI HYROS. React/Next/Supabase no se pueden copiar directamente a este template de JavaScript/Vercel/Redis.

## Evidencia y alcance

- Se revisaron ambos repositorios, las tres referencias de la documentacion actual, el catalogo MCP real y publicaciones publicas.
- REST: version 1.43, 41 rutas y 62 operaciones. MCP: 66 herramientas, 35 declaradas de lectura y 31 de escritura. Webhooks: version 1.2, 11 eventos.
- La clave de `.env.development.local` autentico correctamente. No se guardaron credenciales ni registros personales en este documento.
- Las pruebas fueron consultas acotadas. No se ejecutaron las operaciones de escritura ni se probo exhaustivamente cada endpoint.
- No se verifico el despliegue de Mosaide ni se ejecutaron sus pruebas. Tener un modulo y tests en el repositorio no demuestra que este operativo en produccion.
- El navegador fallo al inicializarse. No se pudo consultar el portal interno de solicitudes ni sus votos.

## Funcionalidades, prioridad y reutilizacion

P0 significa necesario para una primera demo convincente. P1 amplia esa demo. P2 es posterior o depende de datos/integraciones adicionales.

| Prioridad | Feature | Resultado para el usuario | Base reutilizable de Mosaide |
|---|---|---|---|
| P0 | Growth War Room | Lista priorizada de escalar, revisar, corregir tracking o esperar, con evidencia y estado de cada decision | `src/lib/mosaide/daily-actions/`, `src/components/actions/` |
| P0 | Attribution Lab | Comparar first click, last click, Scientific y modelos propios sobre un conjunto controlado de conversiones | `source-flow/`, componentes Sankey, artefactos |
| P0 | Late Conversion / Hidden Winners | Mostrar cuando una mala lectura de corto plazo contradice ventas posteriores o contribuciones de apertura | Funnel, source flow, detectores; necesita motor temporal nuevo |
| P0 | Profit + LTV | Decidir con margen, recompra y plazo de recuperacion; distinguir observado de estimado | `src/lib/mosaide/profit/` |
| P0 | Evidence Drawer | Reconstruir cada afirmacion: cuenta, fechas, modelo, cobertura, consulta y registros de soporte | Evidencia de daily actions, artifacts y tool calls |
| P1 | Journey + Funnel Doctor | Localizar la etapa que empeora y abrir los recorridos relacionados | `funnel/`, `source-flow/` |
| P1 | Creative Intelligence | Agrupar concepto, angulo, hook, formato y variante; detectar cuando una variante sostiene el promedio | `creative/`, `features/creative-explorer/` |
| P1 | Tracking Fix Wizard | Diagnostico guiado, impacto afectado, propuesta concreta de correccion y comprobacion posterior | `tracking-health.ts`, diagnostics, setup-health-panel |
| P1 | Agency Portfolio | Priorizar cuentas por problemas y oportunidades; abrir el analisis de cada cliente | `portfolio/`, workspace switcher |
| P1 | Contest / Client Evidence Export | Informe compartible con hallazgo, calculo, decision, resultado observado y proceso reproducible | `reports/`, artifacts, branding, sharing |
| P1 | Daily Brief + Alerts | Informar que cambio desde la ultima lectura, con enlace al analisis | `alerts/`, delivery-runner, Slack y email |
| P2 | Event-driven Sync | Reducir el retraso de cambios importantes y mantener una conciliacion programada | Webhook receiver y subscription store, despues de corregir su contrato |
| P2 | Budget Scenario Planner | Comparar escenarios con restricciones de margen, madurez y presupuesto | Scale Advisor + motor de profit; curva CAC pendiente de validacion |
| P2 | Decision Journal | Registrar recomendacion, accion tomada, hipotesis y evolucion posterior | Actions + experiments, corrigiendo la interpretacion estadistica |

### Detalles que harian destacar el producto

1. **Dos modos de negocio.** En ventas por llamada: lead cualificado, llamada, asistencia y venta. En ecommerce: primera compra, recompra, devoluciones y suscripciones. Solo mostrar etapas respaldadas por los datos.
2. **Tiempo de conversion.** Mostrar distribuciones del retraso y comparar cohortes que han tenido tiempo equivalente para convertir. Una cohorte reciente no debe parecer peor por ser mas joven.
3. **Modelos propios transparentes.** Lineal, posicion y decaimiento temporal configurables, con pesos visibles y un grupo sin atribucion. Scientific sigue siendo el modelo del proveedor, no una replica inventada.
4. **Comparaciones controladas.** Mantener constantes ventana, moneda, conversiones, refunds y tratamiento de organico al comparar modelos. Explicar diferencias de cobertura respecto de reportes nativos.
5. **Rentabilidad con cobertura.** Permitir margenes por producto/oferta, comisiones y gastos. Un coste ausente significa desconocido; no asumir que todo el ingreso es beneficio. Evitar descontar dos veces costes ya incluidos.
6. **Confianza comprensible.** Exponer cantidad de conversiones, madurez, datos faltantes y fecha del ultimo sync. No inventar un porcentaje de certeza.
7. **Accion y seguimiento.** Guardar responsable, estado y fecha de revision. Una recomendacion solo se convierte en accion externa cuando se implementa el conector correspondiente.
8. **Asistente contextual.** Preguntar por una fila, una alerta o una comparacion; devolver evidencia navegable. La matematica debe ser determinista y el modelo explicar sus resultados.
9. **Creativos inspeccionables.** Usar imagen/video real cuando la integracion entregue el asset o exista un conector autorizado. Los nombres de anuncios no permiten inferir de forma fiable el contenido visual.
10. **Datos historicos reproducibles.** Versionar snapshots y configuracion para poder explicar por que una recomendacion cambio.

## Hallazgos que conviene corregir antes de portar

| Hallazgo | Evidencia local | Implicacion |
|---|---|---|
| El ROAS se recalcula con `revenue / cost` y sobreescribe el valor recibido | AI HYROS `public/shared/metrics.js`, `derive()` | Contrastar con ingreso total y rebills antes de alimentar recomendaciones |
| La particion nuevo/recurrente usa `sale.recurring` | Mosaide `src/lib/mosaide/portfolio/new-existing.ts` | Una recompra no recurrente puede acabar clasificada como cliente nuevo; utilizar indicadores de primera compra o historial suficiente |
| Un ganador con poco gasto no exige suficientes conversiones ni madurez | Mosaide `daily-actions/pattern-detectors.ts`, `detectSilentWinner()` | Portar como candidato a investigacion y agregar controles antes de recomendar escalar |
| El veredicto `likely_significant` depende de 30 observaciones y 10% de diferencia | Mosaide `command-center/experiments.ts`, `judge()` | Es una heuristica, no una prueba estadistica ni evidencia causal |
| Firma webhook incompatible con el formato documentado actual | Mosaide `src/app/api/webhooks/hyros/[token]/route.ts`, `verifyHmac()` | Actualizar parser y mensaje firmado; agregar pruebas con payloads oficiales antes de reutilizar |
| Algunas herramientas de reconciliacion usan muestras | Mosaide `server/playbook-data.ts`, `chat/tool-set.ts` | Mantener la separacion estructural entre datos demo y reales; no anunciar Meta/GHL en vivo sin comprobar el flujo |
| Funnel y Ad LTV son demo-only en el template | AI HYROS `public/features/funnel/`, `adltv/` | Convertirlos en features reales con estados de cobertura y datos faltantes |

Estos hallazgos proceden de inspeccion de codigo. No equivalen a una auditoria completa de ambos productos.

## Sync y webhooks

AI HYROS declara `0 9 * * *` en `vercel.json`: una ejecucion diaria a las 09:00 UTC, mas Refresh manual. El cron distribuye el presupuesto de ejecucion entre cuentas; una cuenta omitida por tiempo debe esperar otra ejecucion. La configuracion local no demuestra que el cron este activo en el despliegue.

Mosaide declara un sync cada hora y ya incluye un receptor de webhooks. El receptor revisado almacena eventos; recibirlos no prueba por si solo que todas las vistas y agregados se actualicen.

- Sync: la app pregunta periodicamente que datos hay.
- Webhook: HYROS avisa cuando ocurre un evento contemplado por la suscripcion.
- Propuesta: webhook para marcar datos afectados y actualizar por bloques; sync programado para conciliar, recuperar omisiones y actualizar gasto publicitario.

No hay que reconstruir todo el dashboard por cada venta. Hay que deduplicar eventos, agrupar trabajo y mostrar por separado la frescura de ventas y gasto. La experiencia deseada es que el dato importante llegue pronto, sin prometer latencia instantanea.

## Pruebas contra MCP, 2026-09-23

| Consulta | Resultado observado | Lo que demuestra |
|---|---|---|
| `tools/list` | 66 herramientas | Credencial y catalogo accesibles |
| `hyros_get_user_info` | Respuesta correcta; valores privados no impresos | Consulta de perfil accesible |
| `hyros_get_ad_accounts` | Una cuenta de muestra y mas paginas | Descubrimiento de cuentas accesible |
| `hyros_get_conversion_paths`, SALE | Muestra inicial sin recorridos poblados; paginacion pendiente | Endpoint operativo, muestra insuficiente para validar journeys |
| `hyros_get_conversion_paths`, CALL | Muestra inicial sin recorridos poblados | Misma limitacion de datos para llamadas |
| `hyros_get_sales` con filtros de actualizacion | Solicitud aceptada, cero registros en la ventana | Contrato aceptado; no demuestra captura correcta de cambios |
| `hyros_get_calls` con filtros de actualizacion | Solicitud aceptada, cero registros en la ventana | Contrato aceptado; requiere caso positivo |
| `hyros_get_marginal_cac_curve`, ACCOUNT, 30 dias | Timeout del cliente a los 15 segundos | No se pudo validar la curva; no prueba que el endpoint este roto |

Ventana de conversiones: 2026-09-01 a 2026-09-22. Ventana de actualizaciones: 2026-09-21 a 2026-09-22. La muestra pertenece al contexto de la clave, no necesariamente a las dos cuentas que se usaran en el concurso.

### Validacion posterior con una cuenta autorizada

El usuario selecciono una credencial del entorno para las consultas. Se uso mediante el contexto del cliente MCP, sin reemplazar la clave por defecto ni modificar configuracion de cuentas. Se omiten la identidad de la cuenta y sus cifras para esta version publica.

La autenticacion funciono y el catalogo devolvio las herramientas documentadas. Las consultas autorizadas confirmaron conversiones de venta y llamada con recorridos, incluidos contactos multiples y conversiones repetidas.

Las ventas tienen mas paginas; no son cifras totales de la cuenta ni una muestra aleatoria. La particion primera/repetida usa `firstSale` y, para llamadas, describe primera llamada/repeticion, no primera compra. No se imprimieron registros personales, nombres de clientes ni credenciales.

La cuenta autorizada sirve como base privada para validar journeys y modelos de atribucion. Estas lecturas no verifican aun la cobertura historica para LTV, los margenes disponibles ni que permita demostrar por separado los dos tipos de negocio. La curva CAC no se volvio a consultar con esta clave durante la investigacion inicial.

## Inventario REST completo

Fuente: [REST OpenAPI 1.43](https://api-docs.hyros.com/ai-context/rest-api.txt). Prefijo `/api/v1.0`, excepto donde se indica. La agrupacion por rutas conserva las 62 operaciones analizadas.

| Ruta | Metodos |
|---|---|
| `/leads` | GET, POST, PUT, DELETE |
| `/leads/tags` | POST |
| `/leads/journey` | GET |
| `/leads/aggregation` | GET |
| `/leads/clicks` | GET |
| `/sales` | GET, PUT |
| `/sales/{id}` | DELETE |
| `/orders` | POST |
| `/orders/{id}` | PUT, DELETE |
| `/calls` | GET, POST, PUT |
| `/calls/{id}` | DELETE |
| `/conversion-paths` | GET |
| `/attribution` | GET |
| `/attribution/roas` | GET |
| `/attribution/marginal-cac-curve` | GET |
| `/attribution/ad-account` | GET |
| `/ad-accounts` | GET |
| `/products` | POST, GET |
| `/products/{id}` | PUT, DELETE |
| `/tags` | GET |
| `/tags/count` | GET |
| `/sources` | GET, POST |
| `/sources/{tag}` | PUT, DELETE |
| `/ads` | GET |
| `/url-rules` | GET, POST |
| `/url-rules/{id}` | GET, PUT, DELETE |
| `/custom-costs` | GET, POST |
| `/custom-costs/{id}` | PUT, DELETE |
| `/clicks` | POST |
| `/carts` | GET, POST, PUT |
| `/user-info` | GET |
| `/keywords` | GET |
| `/subscriptions` | GET, POST, PUT |
| `/tracking-script` | GET |
| `/api/v1/domains` | GET |
| `/stages` | GET |
| `/webhook-subscriptions` | POST, GET |
| `/webhook-subscriptions/{externalId}` | DELETE |
| `/reports/generate` | POST |
| `/reports/poll/{externalId}` | GET |
| `/requests/{request_id}` | GET |

## Inventario MCP completo

Fuente: [MCP](https://api-docs.hyros.com/ai-context/mcp.txt), contrastada con `tools/list`. Todos los nombres siguientes llevan el prefijo `hyros_`. Se agrupan las 66 herramientas; esta es una clasificacion para planificar el producto.

| Familia | Herramientas | Uso propuesto |
|---|---|---|
| Leads | `get_leads`, `get_lead_journey`, `get_leads_aggregation`, `get_lead_clicks`, `create_lead`, `update_lead`, `add_tags_to_leads`, `delete_lead` | Funnel, evidencia, segmentos |
| Ventas y pedidos | `get_sales`, `get_conversion_paths`, `update_sale`, `delete_sale`, `create_order`, `update_order`, `refund_order` | Rentabilidad, cohortes y modelos |
| Carritos | `get_carts`, `create_cart`, `update_cart` | Analisis ecommerce |
| Suscripciones | `get_subscriptions`, `create_subscription`, `update_subscription` | Retencion y valor posterior |
| Llamadas | `get_calls`, `create_call`, `update_call`, `delete_call` | Calidad y etapas comerciales |
| Clicks | `create_click` | Integraciones futuras |
| Productos | `get_products`, `create_product`, `update_product`, `delete_product` | Catalogo y configuracion de margen |
| Fuentes y anuncios | `get_sources`, `get_ads`, `get_keywords`, `create_source`, `update_source`, `delete_source` | Identidad y agrupacion creativa |
| Tags y etapas | `get_tags_count`, `get_tags`, `get_stages` | Segmentos y pipeline |
| Reglas URL | `get_url_rules`, `get_url_rule`, `create_url_rule`, `update_url_rule`, `delete_url_rule` | Diagnostico y propuesta de reparacion |
| Costes | `get_custom_costs`, `create_custom_cost`, `update_custom_cost`, `delete_custom_cost` | Configuracion economica |
| Atribucion | `get_roas_report`, `get_attribution_report`, `get_ad_account_report`, `get_ad_accounts`, `get_marginal_cac_curve` | Comparacion y recomendaciones |
| Reportes | `generate_public_report`, `poll_public_report_result` | Agregaciones especializadas |
| Tracking | `get_account_tracking_script`, `get_tracking_script_with_custom_domain`, `get_domains`, `assert_script_presence_on_domain`, `get_tracking_script` | Health y setup |
| Integraciones y docs | `get_integrations_types`, `get_active_external_integrations`, `check_tracking_parameters_for_integrations`, `search_hyros_docs` | Diagnostico contextual |
| Cuenta | `get_user_info` | Contexto de cuenta |
| Operaciones | `get_request_status` | Comprobacion de cambios asincronos |

## Eventos webhook

Fuente: [Webhooks 1.2](https://api-docs.hyros.com/ai-context/webhooks.txt).

| Eventos | Uso propuesto |
|---|---|
| `sale.attributed`, `sale.refunded` | Marcar ingresos y rentabilidad para recalculo |
| `lead.opted.in`, `lead.opted.in.first.time` | Actualizar entradas del funnel |
| `lead.origin.assigned` | Revisar identidad y deduplicacion |
| `lead.stage.changed` | Actualizar etapas |
| `lead.tag.added`, `lead.tag.removed` | Revisar segmentos afectados |
| `call.attributed` | Actualizar pipeline de llamadas |
| `subscription.created`, `subscription.status.changed` | Actualizar suscripciones y retencion |

## Feedback concreto para el equipo de HYROS

- El contrato MCP real de ventas/llamadas publica filtros `updatedFromDate` y `updatedToDate` que no aparecen en los parametros REST equivalentes del OpenAPI consultado. Hay que documentar la paridad real y probar cambios conocidos.
- La clave API funciona contra MCP, mientras la referencia describe OAuth. Conviene aclarar oficialmente el uso servidor-a-servidor.
- La prueba CAC agoto nuestro plazo. Pedir orientacion sobre latencia, limites y procesamiento asincrono; adjuntar una reproduccion acotada sin registros personales.
- Los objetos de configuracion de reportes necesitan ejemplos completos por familia y errores claros para opciones incompatibles.
- Conviene explicar mejor cuando un conversion path viene vacio, que cobertura esperar y que diagnostico seguir.
- Mantener una prueba de compatibilidad que compare el catalogo vivo, los enums y los contratos publicados.

## Lo que todavia requiere validacion

El nuevo acceso a conversion paths permite intentar modelos propios sin consultar individualmente todos los journeys. No garantiza historial completo, identidad perfecta ni causalidad. El producto debe mostrar la cobertura real y permitir investigar una discrepancia.

Para LTV por anuncio, no basta con renombrar una columna. Definiremos cohortes de adquisicion, ventana de observacion y tratamiento de recompra; contrastaremos la semantica del LTV nativo antes de usarlo como evidencia de retencion especifica por anuncio.

La curva CAC resume historia observada. No demuestra que aumentar presupuesto cause el mismo resultado. Un planificador debe presentar escenarios y limites, no promesas de beneficio.

Los endpoints revisados no ofrecen un control general para pausar anuncios o cambiar presupuestos en Meta/Google. Esa ejecucion necesita integraciones adicionales. El primer entregable puede producir una decision verificable y registrar la accion manual.

No toda venta sin atribucion es tracking roto; puede ser organica o carecer de historial. No toda caida de ROAS es fatiga creativa. El diagnostico debe separar observacion, hipotesis y comprobacion.

## Senales de mercado

La lectura publica de X fue parcial: el perfil directo no devolvio contenido util y los indices/espejos mostraron snapshots de fechas diferentes. No se obtuvo un ranking verificable de peticiones de clientes.

Las publicaciones atribuidas a HYROS sugieren investigar conversiones tardias, diferencias entre modelos y errores al escalar por ROAS con poco gasto. Son hipotesis de producto, no evidencia de demanda priorizada. [Contenido indexado de HYROS](https://mobile.twstalker.com/hyros_official).

HYROS ya ofrece envio programado de dashboards por email. El export propuesto debe aportar el expediente de una decision, no basar la novedad solamente en mandar reportes. [Changelog 2.6.7, 18 de mayo de 2026](https://hyros.com/updates/changelog/version-2-6-7/).

Existe un portal oficial para solicitudes y votos. La siguiente validacion de demanda deberia contrastar alli las propuestas y entrevistar a operadores de ambos tipos de negocio. [Anuncio del portal](https://hyros.com/updates/changelog/version-2-1-4/).

## Secuencia de trabajo propuesta

1. Usar una cuenta autorizada para contrastar una ventana con HYROS y cerrar definiciones de ingresos, moneda, fecha y atribucion. Verificar que datos respaldan cada caso de negocio y resolver los calculos incompatibles con los datos actuales.
2. Crear el motor de conversiones/evidencia y publicar Attribution Lab con cobertura visible.
3. Construir War Room y Hidden Winners sobre ese motor, con escenarios reales de ventas por llamada y ecommerce.
4. Anadir rentabilidad, cohortes y creativos; integrar funnel y Tracking Fix Wizard.
5. Completar portfolio, export y proceso MCP reproducible; medir tiempo ahorrado y recoger feedback.
6. Habilitar actualizaciones por eventos cuando se haya verificado su flujo completo; conservar conciliacion programada.

La primera demo debe recorrer un caso entero: detectar una decision dudosa, explicar el motivo, abrir la evidencia, comparar alternativas y exportar la conclusion. Expandir despues las pantallas que aporten valor a ese recorrido.

## Entrega del concurso

- Demo de ventas por llamada y demo ecommerce, con datos reales que puedan mostrarse.
- Prompts exactos, configuracion, consultas utilizadas, pasos de instalacion y limitaciones conocidas.
- Comparacion con una tarea manual: mismos datos y criterios, midiendo tiempo de analisis y errores detectados.
- Separar beneficio observado de oportunidad estimada. Una comparacion antes/despues sin control no demuestra causalidad.
- Feedback tecnico con reproducciones de problemas y mejoras concretas del API/MCP.
- Confirmar con organizacion si admiten codigo previo y como presentar aportaciones relacionadas en ambas categorias.
- La pregunta sobre datos anonimizados significa poder ocultar nombres, emails e identificadores en el material publico. No se ha autorizado publicar informacion de cuentas ni se ha enviado nada.

La cuenta y la credencial elegidas por el usuario se mantienen privadas. Pendiente: validar los casos de negocio y seleccionar el material que se puede mostrar publicamente.
