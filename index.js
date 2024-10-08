import Fastify from 'fastify';
import WebSocket from 'ws';
import fs from 'fs';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

// Cargar variables de entorno desde el archivo .env
dotenv.config();

// Obtener la clave de la API de OpenAI desde las variables de entorno. Debes tener acceso a la API Realtime de OpenAI.
const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
    console.error('Falta la clave de API de OpenAI. Configúrala en el archivo .env.');
    process.exit(1);
}

// Inicializar Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constantes
const SYSTEM_MESSAGE = 'Eres un asistente muy obediente, te gusta enseñarme sobre finanzas y economía. Hablás español con el acento paraguayo';
const VOICE = 'alloy';
const PORT = process.env.PORT || 5050; // Permitir la asignación dinámica de puertos

// Lista de Tipos de Eventos para registrar en la consola. Ver la documentación de la API Realtime de OpenAI. (session.updated se maneja por separado.)
const LOG_EVENT_TYPES = [
    'response.content.done',
    'rate_limits.updated',
    'response.done',
    'input_audio_buffer.committed',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started',
    'session.created'
];

// Ruta Raíz
fastify.get('/', async (request, reply) => {
    reply.send({ message: '¡El servidor de Media Stream de Twilio está en funcionamiento!' });
});

// Ruta para que Twilio maneje las llamadas entrantes y salientes
// Puntuación en <Say> para mejorar la traducción de texto a voz
fastify.all('/incoming-call', async (request, reply) => {
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Say>Por favor, espera mientras conectamos tu llamada con el asistente de voz de IA, impulsado por Twilio y la API Realtime de OpenAI</Say>
                              <Pause length="1"/>
                              <Say>¡Ok, ya puedes empezar a hablar!</Say>
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream" />
                              </Connect>
                          </Response>`;

    reply.type('text/xml').send(twimlResponse);
});

// Ruta de WebSocket para el media-stream
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Cliente conectado');

        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });

        let streamSid = null;

        const sendSessionUpdate = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    turn_detection: { type: 'server_vad' },
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    voice: VOICE,
                    instructions: SYSTEM_MESSAGE,
                    modalities: ["text", "audio"],
                    temperature: 0.8,
                }
            };

            console.log('Enviando actualización de sesión:', JSON.stringify(sessionUpdate));
            openAiWs.send(JSON.stringify(sessionUpdate));
        };

        // Evento de apertura para el WebSocket de OpenAI
        openAiWs.on('open', () => {
            console.log('Conectado a la API Realtime de OpenAI');
            setTimeout(sendSessionUpdate, 250); // Asegurar estabilidad de conexión, enviar después de .25 segundos
        });

        // Escuchar mensajes del WebSocket de OpenAI (y enviar a Twilio si es necesario)
        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Evento recibido: ${response.type}`, response);
                }

                if (response.type === 'session.updated') {
                    console.log('Sesión actualizada correctamente:', response);
                }

                if (response.type === 'response.audio.delta' && response.delta) {
                    const audioDelta = {
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: Buffer.from(response.delta, 'base64').toString('base64') }
                    };
                    connection.send(JSON.stringify(audioDelta));
                }
            } catch (error) {
                console.error('Error al procesar el mensaje de OpenAI:', error, 'Mensaje en bruto:', data);
            }
        });

        // Manejar mensajes entrantes de Twilio
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'media':
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            const audioAppend = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };

                            openAiWs.send(JSON.stringify(audioAppend));
                        }
                        break;
                    case 'start':
                        streamSid = data.start.streamSid;
                        console.log('El stream entrante ha comenzado', streamSid);
                        break;
                    default:
                        console.log('Evento no relacionado con medios recibido:', data.event);
                        break;
                }
            } catch (error) {
                console.error('Error al analizar el mensaje:', error, 'Mensaje:', message);
            }
        });

        // Manejar cierre de la conexión
        connection.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log('Cliente desconectado.');
        });

        // Manejar cierre y errores del WebSocket
        openAiWs.on('close', () => {
            console.log('Desconectado de la API Realtime de OpenAI');
        });

        openAiWs.on('error', (error) => {
            console.error('Error en el WebSocket de OpenAI:', error);
        });
    });
});

fastify.listen({ port: PORT }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`El servidor está escuchando en el puerto ${PORT}`);
});
