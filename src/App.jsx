import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithCustomToken, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, addDoc, onSnapshot, query, where, updateDoc, doc, Timestamp } from 'firebase/firestore';

// --- CONFIGURACIÓN E INICIALIZACIÓN DE FIREBASE (REQUIERE VARIABLES GLOBALES) ---
// Variables globales proporcionadas por el entorno (MANDATORIO USARLAS)
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : null;
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

// Helper para convertir el formato de la fecha de Firestore a string legible
const formatTimestamp = (timestamp) => {
  if (!timestamp || !timestamp.toDate) return 'N/A';
  return timestamp.toDate().toLocaleString('es-ES', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: true
  });
};

// Objeto que define el esquema de una cita (para TypeScript/claridad)
/**
 * @typedef {object} Appointment
 * @property {string} id
 * @property {string} name
 * @property {string} cedula
 * @property {string} phone
 * @property {string} dateRequested
 * @property {Timestamp} timestamp
 * @property {string} status // 'PENDIENTE', 'CONFIRMADA', 'RECHAZADA'
 * @property {string} confirmationDate
 * @property {string} confirmationTime
 * @property {number | string} cost
 * @property {string} notes
 */

// --- MAIN APPLICATION COMPONENT ---
const App = () => {
  // Estados de la aplicación
  const [db, setDb] = useState(null);
  const [auth, setAuth] = useState(null);
  const [userId, setUserId] = useState(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [isAdministrator, setIsAdministrator] = useState(false); // Determina si es Thailis o cliente
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('home'); // 'home', 'client', 'admin'

  // Formulario del cliente
  const [clientForm, setClientForm] = useState({
    name: '',
    cedula: '',
    phone: '',
    dateRequested: new Date().toISOString().split('T')[0], // Fecha actual por defecto
  });
  const [submissionMessage, setSubmissionMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Formulario de confirmación (Admin)
  const [adminConfirmation, setAdminConfirmation] = useState({
    confirmationDate: '',
    confirmationTime: '',
    cost: '',
    notes: '',
  });

  const [selectedAppointment, setSelectedAppointment] = useState(null);

  // --- EFECTO DE INICIALIZACIÓN DE FIREBASE Y AUTENTICACIÓN ---
  useEffect(() => {
    if (firebaseConfig) {
      try {
        const app = initializeApp(firebaseConfig);
        const firestore = getFirestore(app);
        const authentication = getAuth(app);
        
        setDb(firestore);
        setAuth(authentication);

        const unsubscribe = onAuthStateChanged(authentication, (user) => {
          if (user) {
            setUserId(user.uid);
            // Thailis tiene un UID fijo para administración
            // IMPORTANTE: En producción real, esto debería estar en reglas de seguridad,
            // pero para este ejemplo, usaremos un chequeo simple de UID.
            // Asumiremos que el UID del admin es fijo o conocido.
            // Para el ejemplo, si está autenticado con el token inicial, es el admin.
            // En un entorno real, usaríamos un mecanismo de roles.
            setIsAdministrator(!!initialAuthToken && user.isAnonymous === false);
          } else {
            setUserId(null);
          }
          setIsAuthReady(true);
        });

        // Autenticación (si hay token, úsalo, sino, anónimo)
        const authenticate = async () => {
          try {
            if (initialAuthToken) {
              await signInWithCustomToken(authentication, initialAuthToken);
            } else {
              await signInAnonymously(authentication);
            }
          } catch (error) {
            console.error("Error durante la autenticación:", error);
            // Si falla la autenticación de token, intenta con anónimo como fallback
            await signInAnonymously(authentication);
          }
        };

        authenticate();

        return () => unsubscribe();
      } catch (e) {
        console.error("Error initializing Firebase:", e);
      }
    }
  }, []);

  // --- EFECTO DE NOTIFICACIONES Y CARGA DE DATOS (Solo para Administrador) ---
  useEffect(() => {
    if (!isAuthReady || !db || !isAdministrator) {
      setLoading(false);
      return;
    }

    setLoading(true);

    // 1. Solicitar Permiso de Notificación
    if ('Notification' in window) {
      Notification.requestPermission().then(permission => {
        if (permission !== 'granted') {
          console.warn("Permiso de notificaciones denegado.");
        }
      });
    }

    // 2. Escuchar la colección de citas
    const appointmentsCollectionPath = `/artifacts/${appId}/public/data/appointments`;
    const appointmentsQuery = query(collection(db, appointmentsCollectionPath));

    let initialLoad = true;
    const unsubscribe = onSnapshot(appointmentsQuery, (snapshot) => {
      const newAppointments = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
        // Asegurarse de que el costo es un número para la interfaz
        cost: parseFloat(doc.data().cost) || doc.data().cost || 0,
      }));

      // Detectar nuevas citas (solo después de la carga inicial)
      if (!initialLoad) {
        const oldIds = new Set(appointments.map(a => a.id));
        const newPendingAppointments = newAppointments.filter(a =>
          a.status === 'PENDIENTE' && !oldIds.has(a.id)
        );

        if (newPendingAppointments.length > 0) {
          console.log(`${newPendingAppointments.length} nuevas citas pendientes detectadas.`);
          // Disparar notificaciones
          if ('Notification' in window && Notification.permission === 'granted') {
            newPendingAppointments.forEach(cita => {
              new Notification("✨ Nueva Cita de Uñas Pendiente", {
                body: `Cliente: ${cita.name}. Día solicitado: ${cita.dateRequested}.`,
                icon: 'https://lucide.dev/icon/calendar',
                badge: 'https://lucide.dev/icon/bell'
              });
            });
          }
        }
      }

      setAppointments(newAppointments);
      setLoading(false);
      initialLoad = false;
    }, (error) => {
      console.error("Error al escuchar citas:", error);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [isAuthReady, db, isAdministrator]);

  // --- LÓGICA DEL CLIENTE ---
  const handleClientFormChange = (e) => {
    const { name, value } = e.target;
    setClientForm(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmitAppointment = async (e) => {
    e.preventDefault();
    if (!db || isSubmitting) return;

    // Validación básica
    if (!clientForm.name || !clientForm.phone || !clientForm.dateRequested) {
      setSubmissionMessage('Por favor, complete todos los campos requeridos.');
      return;
    }

    setIsSubmitting(true);
    setSubmissionMessage('Enviando solicitud...');

    try {
      const appointmentData = {
        name: clientForm.name,
        cedula: clientForm.cedula || 'N/A',
        phone: clientForm.phone,
        dateRequested: clientForm.dateRequested,
        timestamp: Timestamp.now(), // Marca de tiempo de la solicitud
        status: 'PENDIENTE', // Estado inicial
        // Campos que llenará la administradora
        confirmationDate: '',
        confirmationTime: '',
        cost: '',
        notes: '',
      };

      const appointmentsCollectionPath = `/artifacts/${appId}/public/data/appointments`;
      await addDoc(collection(db, appointmentsCollectionPath), appointmentData);

      setSubmissionMessage('✅ ¡Solicitud de cita enviada! Thailis te contactará pronto para confirmar los detalles.');
      setClientForm({
        name: '',
        cedula: '',
        phone: '',
        dateRequested: new Date().toISOString().split('T')[0],
      });
    } catch (error) {
      console.error("Error al enviar la cita:", error);
      setSubmissionMessage('❌ Error al enviar la solicitud. Intente de nuevo.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // --- LÓGICA DEL ADMINISTRADOR ---

  const pendingAppointments = useMemo(() => appointments.filter(a => a.status === 'PENDIENTE'), [appointments]);
  const confirmedAppointments = useMemo(() => appointments.filter(a => a.status === 'CONFIRMADA'), [appointments]);
  const rejectedAppointments = useMemo(() => appointments.filter(a => a.status === 'RECHAZADA'), [appointments]);

  const handleOpenConfirmationModal = (appointment) => {
    setSelectedAppointment(appointment);
    // Inicializar el formulario de confirmación con datos existentes si los hay
    setAdminConfirmation({
      confirmationDate: appointment.confirmationDate || appointment.dateRequested || '',
      confirmationTime: appointment.confirmationTime || '',
      cost: appointment.cost || '',
      notes: appointment.notes || '',
    });
  };

  const handleAdminConfirmationChange = (e) => {
    const { name, value } = e.target;
    setAdminConfirmation(prev => ({ ...prev, [name]: value }));
  };

  const handleConfirmAppointment = async () => {
    if (!db || !selectedAppointment || !adminConfirmation.confirmationDate || !adminConfirmation.confirmationTime || !adminConfirmation.cost) {
      alert("Por favor, rellene Fecha, Hora y Costo de la confirmación.");
      return;
    }

    try {
      const appointmentRef = doc(db, `/artifacts/${appId}/public/data/appointments`, selectedAppointment.id);
      
      const updateData = {
        status: 'CONFIRMADA',
        confirmationDate: adminConfirmation.confirmationDate,
        confirmationTime: adminConfirmation.confirmationTime,
        cost: parseFloat(adminConfirmation.cost),
        notes: adminConfirmation.notes,
      };

      await updateDoc(appointmentRef, updateData);
      setSelectedAppointment(null);
      alert("Cita Confirmada y Actualizada exitosamente.");
    } catch (error) {
      console.error("Error al confirmar la cita:", error);
      alert("Error al confirmar la cita. Revise la consola.");
    }
  };

  const handleRejectAppointment = async () => {
    if (!db || !selectedAppointment) return;

    try {
      const appointmentRef = doc(db, `/artifacts/${appId}/public/data/appointments`, selectedAppointment.id);
      
      const updateData = {
        status: 'RECHAZADA',
        notes: adminConfirmation.notes || 'Cita rechazada por indisponibilidad de horario o motivo desconocido.',
        // Limpiamos los campos de confirmación
        confirmationDate: '',
        confirmationTime: '',
        cost: '',
      };

      await updateDoc(appointmentRef, updateData);
      setSelectedAppointment(null);
      alert("Cita Rechazada exitosamente.");
    } catch (error) {
      console.error("Error al rechazar la cita:", error);
      alert("Error al rechazar la cita. Revise la consola.");
    }
  };

  // --- VISTAS / RENDERING ---

  // Componente Reutilizable de Cita
  const AppointmentCard = ({ appointment, isAdmin, onSelect }) => (
    <div className={`p-4 mb-3 rounded-lg shadow-md transition duration-300 transform hover:scale-[1.01]
      ${appointment.status === 'PENDIENTE' ? 'bg-amber-50 border-l-4 border-amber-500' :
        appointment.status === 'CONFIRMADA' ? 'bg-emerald-50 border-l-4 border-emerald-500' :
        'bg-red-50 border-l-4 border-red-500'
      }`}>
      <div className="flex justify-between items-start">
        <h3 className="font-bold text-lg text-gray-800">{appointment.name}</h3>
        <span className={`text-sm font-semibold px-3 py-1 rounded-full ${
          appointment.status === 'PENDIENTE' ? 'bg-amber-500 text-white' :
          appointment.status === 'CONFIRMADA' ? 'bg-emerald-500 text-white' :
          'bg-red-500 text-white'
        }`}>
          {appointment.status}
        </span>
      </div>

      <p className="mt-1 text-sm text-gray-600">**Solicitado para:** {appointment.dateRequested}</p>
      <p className="text-xs text-gray-500">Solicitud hecha el: {formatTimestamp(appointment.timestamp)}</p>
      
      <div className="mt-3 border-t border-gray-200 pt-3 space-y-1 text-sm">
        <p><span className="font-medium">Cédula:</span> {appointment.cedula}</p>
        <p><span className="font-medium">Teléfono:</span> {appointment.phone}</p>
        
        {/* Detalles de confirmación (si están disponibles) */}
        {appointment.status !== 'PENDIENTE' && (
          <div className="mt-2 p-2 bg-white rounded-md border border-dashed border-gray-300">
            <p className="font-bold text-indigo-600">Detalles Validados:</p>
            <p><span className="font-medium">Día:</span> {appointment.confirmationDate}</p>
            <p><span className="font-medium">Hora:</span> {appointment.confirmationTime || 'No especificada'}</p>
            <p><span className="font-medium">Costo:</span> {appointment.cost ? `Bs. ${appointment.cost.toFixed(2)}` : 'A definir'}</p>
            {appointment.notes && <p><span className="font-medium">Notas:</span> {appointment.notes}</p>}
          </div>
        )}

        {isAdmin && (
          <button
            onClick={() => onSelect(appointment)}
            className="mt-3 w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2 px-4 rounded-lg transition duration-150 shadow-md"
          >
            {appointment.status === 'PENDIENTE' ? 'Validar y Confirmar' : 'Ver Detalles / Editar'}
          </button>
        )}
      </div>
    </div>
  );

  // Modal de Confirmación para Admin
  const ConfirmationModal = () => {
    if (!selectedAppointment) return null;
    
    // Obtener la fecha y hora actual para el min/max de los inputs
    const today = new Date().toISOString().split('T')[0];

    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-xl shadow-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
          <h2 className="text-2xl font-bold mb-4 text-indigo-700">Validar Cita de {selectedAppointment.name}</h2>
          <p className="mb-4 text-sm text-gray-600">
            Cliente solicitó: <span className="font-semibold">{selectedAppointment.dateRequested}</span>
          </p>

          <form className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <label className="block">
                <span className="text-gray-700 font-medium">Día de Asistencia (Validado)</span>
                <input
                  type="date"
                  name="confirmationDate"
                  value={adminConfirmation.confirmationDate}
                  onChange={handleAdminConfirmationChange}
                  min={today}
                  required
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2 border"
                />
              </label>
              <label className="block">
                <span className="text-gray-700 font-medium">Hora de Asistencia (Validada)</span>
                <input
                  type="time"
                  name="confirmationTime"
                  value={adminConfirmation.confirmationTime}
                  onChange={handleAdminConfirmationChange}
                  required
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2 border"
                />
              </label>
            </div>
            
            <label className="block">
              <span className="text-gray-700 font-medium">Costo del Trabajo (Bs.)</span>
              <input
                type="number"
                name="cost"
                value={adminConfirmation.cost}
                onChange={handleAdminConfirmationChange}
                placeholder="Ej: 50.00"
                min="0"
                step="0.01"
                required
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2 border"
              />
            </label>

            <label className="block">
              <span className="text-gray-700 font-medium">Notas Adicionales (Opcional)</span>
              <textarea
                name="notes"
                value={adminConfirmation.notes}
                onChange={handleAdminConfirmationChange}
                rows="3"
                placeholder="Ej: Incluye diseño en 2 uñas. Recordar traer uñas limpias."
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2 border"
              ></textarea>
            </label>
          </form>

          <div className="mt-6 flex justify-between space-x-3">
            <button
              onClick={() => setSelectedAppointment(null)}
              className="px-4 py-2 bg-gray-200 text-gray-800 rounded-lg hover:bg-gray-300 transition duration-150 font-medium"
            >
              Cerrar
            </button>
            <div className='flex space-x-3'>
              <button
                onClick={handleRejectAppointment}
                className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition duration-150 font-bold shadow-lg"
              >
                Rechazar Cita
              </button>
              <button
                onClick={handleConfirmAppointment}
                className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition duration-150 font-bold shadow-lg"
              >
                Confirmar Cita
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };


  // Vista del Cliente (Formulario de Solicitud)
  const ClientView = () => (
    <div className="max-w-md mx-auto p-6 bg-white rounded-2xl shadow-xl border border-pink-100">
      <h2 className="text-3xl font-extrabold text-pink-600 text-center mb-6">
        Solicitar Cita <span className="text-sm block font-normal text-gray-500">THAIS GUASTELLA NAILS DESIGNER</span>
      </h2>
      
      <form onSubmit={handleSubmitAppointment} className="space-y-4">
        <div>
          <label htmlFor="name" className="block text-sm font-medium text-gray-700">Nombre Completo</label>
          <input
            type="text"
            id="name"
            name="name"
            value={clientForm.name}
            onChange={handleClientFormChange}
            required
            className="mt-1 block w-full px-4 py-2 border border-gray-300 rounded-lg shadow-sm focus:ring-pink-500 focus:border-pink-500"
            placeholder="Ej: María Pérez"
          />
        </div>
        <div>
          <label htmlFor="cedula" className="block text-sm font-medium text-gray-700">Cédula</label>
          <input
            type="text"
            id="cedula"
            name="cedula"
            value={clientForm.cedula}
            onChange={handleClientFormChange}
            className="mt-1 block w-full px-4 py-2 border border-gray-300 rounded-lg shadow-sm focus:ring-pink-500 focus:border-pink-500"
            placeholder="Ej: V-12345678"
          />
        </div>
        <div>
          <label htmlFor="phone" className="block text-sm font-medium text-gray-700">Teléfono (WhatsApp)</label>
          <input
            type="tel"
            id="phone"
            name="phone"
            value={clientForm.phone}
            onChange={handleClientFormChange}
            required
            className="mt-1 block w-full px-4 py-2 border border-gray-300 rounded-lg shadow-sm focus:ring-pink-500 focus:border-pink-500"
     
