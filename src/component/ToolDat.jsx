import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import './ToolDat.css';

// ========== CACHE TOÀN CỤC ==========
const globalCache = {
  traineeData: new Map(),   // `${courseId}:${traineeId}` -> { details, warnings }
  sessionData: new Map(),   // traineeId -> { sessions, summary, warnings }
  archivedData: new Map(),  // archivedUrl -> details[]
};

const inflightArchived = new Map(); // archivedUrl -> Promise
const inflightSessions = new Map(); // traineeId -> Promise

const API_BASE_URL = 'https://jira.shlx.vn/v1';
const S3_BASE_URL = 'https://s3-north1.viettelidc.com.vn/tp-shlx-data';

/** Giới hạn số request song song, không throttle thêm req/s (nguyên nhân ~15s). */
function createPool(maxConcurrent) {
  let active = 0;
  const queue = [];

  const runNext = () => {
    while (active < maxConcurrent && queue.length > 0) {
      const job = queue.shift();
      active += 1;
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, job.reject)
        .finally(() => {
          active -= 1;
          runNext();
        });
    }
  };

  return function schedule(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      runNext();
    });
  };
}

const jiraPool = createPool(8);
const s3Pool = createPool(12);

// ========== RETRY CHO 429 / 503 / 5xx ==========
function getRetryDelay(error, attempt) {
  const retryAfter = error?.response?.headers?.['retry-after'];
  if (retryAfter) {
    const sec = parseInt(retryAfter, 10);
    if (!isNaN(sec)) return sec * 1000 + Math.random() * 500;
  }
  const base = Math.min(1000 * Math.pow(2, attempt), 15000);
  return base + Math.random() * 500;
}

async function fetchWithRetry(url, config = {}, schedule = jiraPool, maxRetries = 4) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await schedule(() => axios.get(url, config));
    } catch (err) {
      lastError = err;
      if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') throw err;

      const status = err.response?.status;
      const isRetryable =
        status === 429 || status === 503 ||
        (status >= 500 && status < 600) || !err.response;

      if (!isRetryable || attempt === maxRetries) throw err;

      const delay = getRetryDelay(err, attempt);
      console.warn(`[Retry ${attempt + 1}/${maxRetries}] ${status || 'network'} — chờ ${Math.round(delay)}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

function extractList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.rows)) return payload.rows;
  return [];
}

function instructorFromTrainee(trainee) {
  return (
    trainee.instructor_name ||
    trainee.giao_vien ||
    trainee.ten_giao_vien ||
    trainee.teacher_name ||
    trainee.instructor ||
    'Chưa có'
  );
}

function latestSessionDetails(sessions, courseName) {
  if (!sessions?.length) {
    return { instructor_name: 'Chưa có', ten_khoa_hoc: courseName || 'Chưa có' };
  }
  const latest = [...sessions].sort(
    (a, b) => new Date(b.start_time) - new Date(a.start_time)
  )[0];
  return {
    instructor_name: latest.instructor_name || 'Chưa có',
    ten_khoa_hoc: latest.ten_khoa_hoc || courseName || 'Chưa có',
  };
}

// ========== FETCH ARCHIVED (có cache + dedupe inflight) ==========
async function fetchArchivedDetailsCached(archivedUrl) {
  if (!archivedUrl) return null;
  if (globalCache.archivedData.has(archivedUrl)) {
    return globalCache.archivedData.get(archivedUrl);
  }
  if (inflightArchived.has(archivedUrl)) {
    return inflightArchived.get(archivedUrl);
  }

  const p = (async () => {
    try {
      const res = await fetchWithRetry(
        `${S3_BASE_URL}/${archivedUrl}`,
        {},
        s3Pool
      );
      const data = extractList(res.data);
      globalCache.archivedData.set(archivedUrl, data);
      return data;
    } catch (err) {
      console.error('Lỗi archived:', archivedUrl, err?.message);
      globalCache.archivedData.set(archivedUrl, null);
      return null;
    } finally {
      inflightArchived.delete(archivedUrl);
    }
  })();

  inflightArchived.set(archivedUrl, p);
  return p;
}

async function fetchSessionsCached(traineeId, token, signal) {
  const cached = globalCache.sessionData.get(traineeId);
  if (cached?.sessions) return cached.sessions;
  if (inflightSessions.has(traineeId)) return inflightSessions.get(traineeId);

  const p = (async () => {
    try {
      const res = await fetchWithRetry(
        `${API_BASE_URL}/trainees/${traineeId}/outdoor-sessions?mark=1`,
        { headers: { Authorization: `Bearer ${token}` }, signal },
        jiraPool
      );
      const sessionsData = extractList(res.data);
      const prev = globalCache.sessionData.get(traineeId) || {};
      globalCache.sessionData.set(traineeId, {
        sessions: sessionsData,
        summary: prev.summary ?? null,
        warnings: prev.warnings ?? null,
      });
      return sessionsData;
    } finally {
      inflightSessions.delete(traineeId);
    }
  })();

  inflightSessions.set(traineeId, p);
  return p;
}

function ToolDat() {
  const [searchTerm, setSearchTerm] = useState('');
  const [courses, setCourses] = useState([]);
  const [filteredCourses, setFilteredCourses] = useState([]);
  const [trainees, setTrainees] = useState([]);
  const [traineeDetails, setTraineeDetails] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedCourse, setSelectedCourse] = useState(null);

  const [showPopup, setShowPopup] = useState(false);
  const [selectedTrainee, setSelectedTrainee] = useState(null);
  const [outdoorSessions, setOutdoorSessions] = useState([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [sessionSummary, setSessionSummary] = useState({});
  const [sessionWarnings, setSessionWarnings] = useState({});

  const [traineeWarnings, setTraineeWarnings] = useState({});
  const [loadingWarnings, setLoadingWarnings] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState({ done: 0, total: 0 });

  const searchRef = useRef(null);
  const dropdownRef = useRef(null);
  const popupRef = useRef(null);
  const tokenRef = useRef('');
  const courseLoadAbortRef = useRef(null);

  const ROAD_FACTOR = 1.0555;
  const MAX_REASONABLE_DISTANCE = 5.0;
  const MIN_REASONABLE_DISTANCE = 0.00005;
  const MAX_TIME_DIFF = 600000;
  const MAX_SPEED = 200;
  const MIN_SPEED = 0.1;
  const STOP_WARNING_MINUTES = 10;

  // ========== TOKEN ==========
  const login = useCallback(async () => {
    try {
      const response = await axios.post(`${API_BASE_URL}/login`, {
        email: 'doluong@shlx.vn',
        password: '123456',
      });
      const d = response.data;
      const tokenValue =
        d.token || d.access_token || d.data?.token || d.data?.access_token;
      if (tokenValue) {
        tokenRef.current = tokenValue;
        return tokenValue;
      }
      throw new Error('Không lấy được token');
    } catch (err) {
      setError('Đăng nhập thất bại: ' + err.message);
      return null;
    }
  }, []);

  const ensureToken = useCallback(async () => {
    if (tokenRef.current) return tokenRef.current;
    return await login();
  }, [login]);

  // ========== FETCH COURSES ==========
  const fetchAllCourses = async () => {
    setLoading(true);
    setError('');
    try {
      const currentToken = await ensureToken();
      if (!currentToken) return;

      const res = await fetchWithRetry(
        `${API_BASE_URL}/courses?ma=&name=&page=1&page_size=200&status=-1`,
        { headers: { Authorization: `Bearer ${currentToken}` } }
      );

      const data = extractList(res.data);

      setCourses(data);
      setFilteredCourses(data);
    } catch (err) {
      setError('Lỗi khi lấy danh sách khóa học: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  // ========== FETCH TRAINEES + DETAILS + WARNINGS ==========
  const fetchTraineesByCourseId = async (course) => {
    const courseId = course.id;
    const courseName = course.ten_khoa_hoc || course.ten_so_gtvt || course.name || 'Chưa có';

    courseLoadAbortRef.current?.abort();
    const controller = new AbortController();
    courseLoadAbortRef.current = controller;
    const { signal } = controller;

    setLoading(true);
    setError('');
    setTrainees([]);
    setTraineeDetails({});
    setTraineeWarnings({});
    setLoadingWarnings(false);

    try {
      const currentToken = await ensureToken();
      if (!currentToken || signal.aborted) return;

      const res = await fetchWithRetry(
        `${API_BASE_URL}/trainees?course_id=${courseId}&name=&id_card=&rf_card=&rf_card_name=&synced=-1&face=-1&page=1&page_size=200&status=-1`,
        { headers: { Authorization: `Bearer ${currentToken}` }, signal }
      );

      const traineesData = extractList(res.data);
      if (signal.aborted) return;

      const detailsMap = {};
      traineesData.forEach((trainee) => {
        detailsMap[trainee.id] = {
          instructor_name: instructorFromTrainee(trainee),
          ten_khoa_hoc: trainee.ten_khoa_hoc || courseName,
        };
      });

      setTrainees(traineesData);
      setTraineeDetails({ ...detailsMap });
      setLoading(false);
      if (traineesData.length === 0) return;

      setLoadingWarnings(true);
      setLoadingProgress({ done: 0, total: traineesData.length });

      let doneCount = 0;
      const bumpProgress = () => {
        doneCount += 1;
        if (doneCount % 4 === 0 || doneCount === traineesData.length) {
          setLoadingProgress({ done: doneCount, total: traineesData.length });
        }
      };

      await Promise.all(
        traineesData.map(async (trainee) => {
          if (signal.aborted) return;
          const cacheKey = `${courseId}:${trainee.id}`;
          const cached = globalCache.traineeData.get(cacheKey);

          if (cached) {
            detailsMap[trainee.id] = cached.details;
            if (cached.warnings?.length > 0) {
              setTraineeWarnings((prev) => ({ ...prev, [trainee.id]: cached.warnings }));
            }
            bumpProgress();
            return;
          }

          try {
            const sessionsData = await fetchSessionsCached(trainee.id, currentToken, signal);
            if (signal.aborted) return;

            const details = latestSessionDetails(sessionsData, courseName);
            if (details.instructor_name === 'Chưa có') {
              details.instructor_name = instructorFromTrainee(trainee);
            }
            detailsMap[trainee.id] = details;
            setTraineeDetails((prev) => ({ ...prev, [trainee.id]: details }));

            if (!sessionsData.length) {
              globalCache.traineeData.set(cacheKey, { details, warnings: [] });
              return;
            }

            const allWarnings = [];
            await Promise.all(
              sessionsData.map(async (session) => {
                if (!session.archived_url || signal.aborted) return;
                const detailsData = await fetchArchivedDetailsCached(session.archived_url);
                if (!detailsData?.length) return;
                detectStopWarnings(detailsData).forEach((x) =>
                  allWarnings.push({
                    ...x,
                    sessionId: session.id,
                    vehiclePlate: session.vehicle_plate || 'Không có',
                    instructorName: session.instructor_name || 'Không có',
                  })
                );
              })
            );

            if (signal.aborted) return;

            allWarnings.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
            if (allWarnings.length > 0) {
              setTraineeWarnings((prev) => ({ ...prev, [trainee.id]: allWarnings }));
            }

            globalCache.traineeData.set(cacheKey, { details, warnings: allWarnings });
          } catch (err) {
            if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') return;
            console.error(`Lỗi trainee ${trainee.id}:`, err?.message);
            detailsMap[trainee.id] = { instructor_name: 'Lỗi', ten_khoa_hoc: 'Lỗi' };
            setTraineeDetails((prev) => ({ ...prev, [trainee.id]: detailsMap[trainee.id] }));
          } finally {
            bumpProgress();
          }
        })
      );

      if (!signal.aborted) setLoadingWarnings(false);
    } catch (err) {
      if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') return;
      setError('Lỗi khi lấy danh sách học viên: ' + err.message);
      setLoading(false);
      setLoadingWarnings(false);
    }
  };

  // ========== TÍNH TOÁN ==========
  const haversineDistance = (lat1, lon1, lat2, lon2) => {
    if ([lat1, lon1, lat2, lon2].some((v) => v === undefined || isNaN(v))) return 0;
    if ((lat1 === 0 && lon1 === 0) || (lat2 === 0 && lon2 === 0)) return 0;

    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) ** 2;
    return parseFloat((R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))).toFixed(6));
  };

  const calculateSpeed = (lat1, lon1, lat2, lon2, timeDiff) => {
    if (timeDiff <= 0) return 0;
    return haversineDistance(lat1, lon1, lat2, lon2) / (timeDiff / 3600000);
  };

  const isNightTime = (date) => {
    const t = date.getHours() * 60 + date.getMinutes();
    return t >= 1080 || t <= 239;
  };

  const calculateSessionSummary = (details) => {
    const empty = {
      totalDistance: 0, totalTime: 0, nightDistance: 0,
      nightTime: 0, totalRecords: 0, nightRecords: 0, validPoints: 0,
    };
    if (!details?.length) return empty;

    const sorted = [...details].sort(
      (a, b) => new Date(a.event_date) - new Date(b.event_date)
    );
    const valid = sorted.filter((item) => {
      const lat = parseFloat(item.lat || item.latitude || 0);
      const lng = parseFloat(item.lng || item.longitude || 0);
      return !(lat === 0 && lng === 0) && !isNaN(lat) && !isNaN(lng);
    });

    if (valid.length < 2) return { ...empty, totalRecords: valid.length };

    let totalDistance = 0, totalTime = 0, nightDistance = 0,
      nightTime = 0, nightRecords = 0, validPoints = 0;

    for (let i = 1; i < valid.length; i++) {
      const prev = valid[i - 1], curr = valid[i];
      const timeDiff = new Date(curr.event_date) - new Date(prev.event_date);
      if (timeDiff <= 0 || timeDiff > MAX_TIME_DIFF) continue;

      const lat1 = parseFloat(prev.lat || prev.latitude || 0);
      const lon1 = parseFloat(prev.lng || prev.longitude || 0);
      const lat2 = parseFloat(curr.lat || curr.latitude || 0);
      const lon2 = parseFloat(curr.lng || curr.longitude || 0);

      const dist = haversineDistance(lat1, lon1, lat2, lon2);
      if (dist < MIN_REASONABLE_DISTANCE || dist > MAX_REASONABLE_DISTANCE) continue;

      const speed = calculateSpeed(lat1, lon1, lat2, lon2, timeDiff);
      if (speed > MAX_SPEED) continue;

      const pv = parseFloat(prev.velocity || prev.speed || 0);
      const cv = parseFloat(curr.velocity || curr.speed || 0);
      if (pv === 0 && cv === 0 && dist < 0.01) continue;

      const adjDist = dist * ROAD_FACTOR;
      totalDistance += adjDist;
      validPoints++;
      if (speed > MIN_SPEED) totalTime += timeDiff;

      if (isNightTime(new Date(curr.event_date))) {
        nightDistance += adjDist;
        nightRecords++;
        if (speed > MIN_SPEED) nightTime += timeDiff;
      }
    }

    return {
      totalDistance: parseFloat(totalDistance.toFixed(6)) * 1000,
      totalTime,
      nightDistance: parseFloat(nightDistance.toFixed(6)) * 1000,
      nightTime,
      totalRecords: valid.length,
      nightRecords,
      validPoints,
    };
  };

  const detectStopWarnings = (details) => {
    if (!details || details.length < 2) return [];

    const sorted = [...details].sort(
      (a, b) => new Date(a.event_date) - new Date(b.event_date)
    );
    const warnings = [];
    let stopStartIndex = -1, stopStartTime = null, isStop = false;

    for (let i = 0; i < sorted.length; i++) {
      const current = sorted[i];
      const velocity = parseFloat(current.velocity || current.speed || 0);
      const currentDate = new Date(current.event_date);
      const lat = parseFloat(current.lat || current.latitude || 0);
      const lng = parseFloat(current.lng || current.longitude || 0);
      const hasValid = !(lat === 0 && lng === 0);

      if (velocity === 0 && hasValid) {
        if (!isStop) {
          isStop = true;
          stopStartIndex = i;
          stopStartTime = currentDate;
        }
        if (i === sorted.length - 1) {
          const duration = (currentDate - stopStartTime) / 60000;
          if (duration > STOP_WARNING_MINUTES) {
            warnings.push(buildWarning(sorted, stopStartIndex, i, stopStartTime, currentDate, duration));
          }
        }
      } else if (velocity !== 0 && hasValid && isStop) {
        const endTime = new Date(sorted[i - 1].event_date);
        const duration = (endTime - stopStartTime) / 60000;
        if (duration > STOP_WARNING_MINUTES) {
          warnings.push(buildWarning(sorted, stopStartIndex, i - 1, stopStartTime, endTime, duration));
        }
        isStop = false;
        stopStartIndex = -1;
        stopStartTime = null;
      }
    }

    return warnings;
  };

  const buildWarning = (sorted, startIdx, endIdx, startTime, endTime, duration) => ({
    startIndex: startIdx,
    endIndex: endIdx,
    startTime,
    endTime,
    duration,
    startLat: parseFloat(sorted[startIdx].lat || sorted[startIdx].latitude || 0),
    startLng: parseFloat(sorted[startIdx].lng || sorted[startIdx].longitude || 0),
    endLat: parseFloat(sorted[endIdx].lat || sorted[endIdx].latitude || 0),
    endLng: parseFloat(sorted[endIdx].lng || sorted[endIdx].longitude || 0),
    note: '',
  });

  // ========== POPUP ==========
  const fetchOutdoorSessions = async (traineeId) => {
    setLoadingSessions(true);
    setError('');

    const cached = globalCache.sessionData.get(traineeId);
    if (cached?.summary && cached?.sessions) {
      setOutdoorSessions(cached.sessions);
      setSessionSummary(cached.summary);
      setSessionWarnings(cached.warnings || {});
      setLoadingSessions(false);
      return;
    }

    setOutdoorSessions([]);
    setSessionSummary({});
    setSessionWarnings({});

    try {
      const currentToken = await ensureToken();
      if (!currentToken) return;

      const sessionsData = cached?.sessions
        || await fetchSessionsCached(traineeId, currentToken);

      setOutdoorSessions(sessionsData);

      const summaryMap = {};
      const warningsMap = {};

      await Promise.all(
        sessionsData.map(async (session) => {
          if (!session.archived_url) {
            summaryMap[session.id] = calculateSessionSummary(null);
            warningsMap[session.id] = [];
            return;
          }
          const details = await fetchArchivedDetailsCached(session.archived_url);
          if (details && details.length > 0) {
            summaryMap[session.id] = calculateSessionSummary(details);
            warningsMap[session.id] = detectStopWarnings(details);
          } else {
            summaryMap[session.id] = calculateSessionSummary(null);
            warningsMap[session.id] = [];
          }
        })
      );

      setSessionSummary(summaryMap);
      setSessionWarnings(warningsMap);

      globalCache.sessionData.set(traineeId, {
        sessions: sessionsData,
        summary: summaryMap,
        warnings: warningsMap,
      });
    } catch (err) {
      if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') return;
      setError('Lỗi khi lấy outdoor sessions: ' + err.message);
    } finally {
      setLoadingSessions(false);
    }
  };

  const handleTraineeClick = (trainee) => {
    setSelectedTrainee(trainee);
    setShowPopup(true);
    fetchOutdoorSessions(trainee.id);
  };

  const closePopup = useCallback(() => {
    setShowPopup(false);
    setSelectedTrainee(null);
    setOutdoorSessions([]);
    setSessionSummary({});
    setSessionWarnings({});
  }, []);

  useEffect(() => {
    const handler = (e) => {
      if (popupRef.current && !popupRef.current.contains(e.target)) closePopup();
    };
    if (showPopup) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showPopup, closePopup]);

  useEffect(() => {
    const handler = (e) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target) &&
        searchRef.current &&
        !searchRef.current.contains(e.target)
      ) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleInputClick = () => {
    if (courses.length === 0) fetchAllCourses();
    setShowDropdown(true);
    setFilteredCourses(courses);
  };

  const handleInputChange = (e) => {
    const value = e.target.value;
    setSearchTerm(value);
    setFilteredCourses(
      courses.filter((c) => {
        const name = c.ten_khoa_hoc || c.ten_so_gtvt || c.name || '';
        return name.toLowerCase().includes(value.toLowerCase());
      })
    );
    setShowDropdown(true);
  };

  const handleSelectCourse = (course) => {
    setSearchTerm(course.ten_khoa_hoc || course.ten_so_gtvt || course.name || 'Không có tên');
    setSelectedCourse(course);
    setShowDropdown(false);
    fetchTraineesByCourseId(course);
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && filteredCourses.length > 0) {
      handleSelectCourse(filteredCourses[0]);
    }
  };

  const getCourseName = (c) =>
    c.ten_khoa_hoc || c.ten_so_gtvt || c.name || c.course_name || 'Không có tên';
  const getTraineeName = (t) =>
    t.ho_va_ten || t.name || t.full_name || t.fullname || 'Không có tên';

  const formatDateTimeUTC7 = (d) => {
    if (!d) return 'Không có';
    try {
      const date = new Date(d);
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')} ${String(date.getDate()).padStart(2, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${date.getFullYear()}`;
    } catch {
      return d;
    }
  };

  const formatDateTimeDisplay = (d) => {
    if (!d) return 'Không có';
    try {
      const date = new Date(d);
      return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
    } catch {
      return d;
    }
  };

  const formatDuration = (ms) => {
    if (!ms) return '0s';
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h > 0 ? `${h}h ${m}m ${sec}s` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  };

  const formatNightDuration = (ms) => {
    if (!ms) return '0 giờ';
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
    return m > 0 ? `${m}m` : `${sec}s`;
  };

  const formatDistance = (m) => {
    if (!m) return '0 m';
    if (m < 1) return '< 1 m';
    if (m < 1000) return `${Math.round(m)} m`;
    return `${(m / 1000).toFixed(2)} km`;
  };

  const calculateTotalSummary = () => {
    return Object.values(sessionSummary).reduce(
      (t, s) => ({
        totalDistance: t.totalDistance + s.totalDistance,
        totalTime: t.totalTime + s.totalTime,
        nightDistance: t.nightDistance + s.nightDistance,
        nightTime: t.nightTime + s.nightTime,
        nightRecords: t.nightRecords + s.nightRecords,
      }),
      { totalDistance: 0, totalTime: 0, nightDistance: 0, nightTime: 0, nightRecords: 0 }
    );
  };

  const getSyncedStatus = (s) =>
    s.synced === true || s.synced === 'true' ? '✅ Đã đồng bộ' : '⏳ Chưa đồng bộ';
  const getVehicle = (s) => s.vehicle_hang || 'hạng xe ??';

  const getAllWarningsFlat = () => {
    const all = [];
    Object.entries(traineeWarnings).forEach(([traineeId, warnings]) => {
      const trainee = trainees.find((t) => t.id == traineeId);
      warnings.forEach((w) => {
        all.push({
          ...w,
          traineeId,
          traineeName: trainee ? getTraineeName(trainee) : 'Không xác định',
        });
      });
    });
    return all.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  };

  return (
    <div className="App">
      <header className="App-header">
        <h1>🔍 Tra cứu học viên theo khóa học</h1>
      </header>

      <div className="search-container" ref={dropdownRef}>
        <div className="search-wrapper" ref={searchRef}>
          <input
            type="text"
            placeholder="Nhập tên khóa học hoặc click để xem tất cả..."
            value={searchTerm}
            onChange={handleInputChange}
            onClick={handleInputClick}
            onKeyPress={handleKeyPress}
            className="search-input"
          />
          <button
            onClick={() => {
              if (courses.length === 0) fetchAllCourses();
              setShowDropdown(!showDropdown);
            }}
            className="search-button"
            disabled={loading}
          >
            {loading ? 'Đang tải...' : '📋'}
          </button>
        </div>

        {showDropdown && (
          <div className="dropdown-menu">
            {loading ? (
              <div className="dropdown-item loading">Đang tải danh sách khóa học...</div>
            ) : filteredCourses.length > 0 ? (
              filteredCourses.map((course) => (
                <div
                  key={course.id}
                  className="dropdown-item"
                  onClick={() => handleSelectCourse(course)}
                >
                  <div className="course-name">{getCourseName(course)}</div>
                  <div className="course-id">ID: {course.id}</div>
                </div>
              ))
            ) : (
              <div className="dropdown-item no-data">Không tìm thấy khóa học nào</div>
            )}
          </div>
        )}
      </div>

      {error && <div className="error-message">{error}</div>}

      {selectedCourse && (
        <div className="courses-info">
          <h2>
            Khóa học đã chọn: <span className="highlight">{getCourseName(selectedCourse)}</span>
          </h2>
          <p>ID khóa học: {selectedCourse.id}</p>
          <p>Số lượng học viên: {trainees.length}</p>
          {loadingWarnings && (
            <p className="loading-progress">
              ⏳ Đang tải chi tiết: {loadingProgress.done}/{loadingProgress.total} học viên
            </p>
          )}
          <p className="hint">💡 Click vào tên học viên để xem chi tiết outdoor sessions</p>
        </div>
      )}

      {trainees.length > 0 && (
        <div className="trainee-table-container">
          <h2>📋 Danh sách học viên</h2>
          <table className="trainee-table">
            <thead>
              <tr>
                <th>STT</th>
                <th>Họ và tên</th>
                <th>Giáo viên</th>
                <th>ID</th>
                <th>Cảnh báo</th>
                <th>Hành động</th>
              </tr>
            </thead>
            <tbody>
              {trainees.map((trainee, index) => {
                const details = traineeDetails[trainee.id] || {
                  instructor_name: 'Đang tải...',
                  ten_khoa_hoc: 'Đang tải...',
                };
                const warnings = traineeWarnings[trainee.id] || [];
                const hasWarnings = warnings.length > 0;
                const isLoadingThis = !traineeDetails[trainee.id];

                return (
                  <tr key={trainee.id || index} className={hasWarnings ? 'has-warning' : ''}>
                    <td>{index + 1}</td>
                    <td
                      className="trainee-name-clickable"
                      onClick={() => handleTraineeClick(trainee)}
                    >
                      {getTraineeName(trainee)}
                    </td>
                    <td>{details.instructor_name}</td>
                    <td className="id-cell">{trainee.id || 'N/A'}</td>
                    <td>
                      {isLoadingThis ? (
                        <span className="loading-small">⏳</span>
                      ) : hasWarnings ? (
                        <span className="warning-badge" title={`${warnings.length} cảnh báo`}>
                          ⚠️ {warnings.length}
                        </span>
                      ) : (
                        <span className="no-warning">✅</span>
                      )}
                    </td>
                    <td>
                      <button
                        className="view-details-btn"
                        onClick={() => handleTraineeClick(trainee)}
                      >
                        📋 Xem chi tiết
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!loading && trainees.length === 0 && selectedCourse && (
        <div className="no-data">
          <p>Không có học viên nào trong khóa học này</p>
        </div>
      )}

      {trainees.length > 0 && Object.keys(traineeWarnings).length > 0 && (
        <div className="warnings-summary-container">
          <h2>⚠️ Danh sách học viên dừng xe quá 10 phút</h2>
          <p className="warning-note">Các trường hợp vận tốc = 0 liên tục trên 10 phút</p>

          <table className="warnings-summary-table">
            <thead>
              <tr>
                <th>STT</th>
                <th>Học viên</th>
                <th>Giáo viên</th>
                <th>Xe</th>
                <th>Thời gian bắt đầu</th>
                <th>Thời gian kết thúc</th>
                <th>Thời gian dừng</th>
                <th>Vị trí</th>
                <th>Hành động</th>
              </tr>
            </thead>
            <tbody>
              {getAllWarningsFlat().map((warning, index) => {
                const trainee = trainees.find((t) => t.id == warning.traineeId);
                return (
                  <tr key={`${warning.traineeId}-${index}`} className="warning-row">
                    <td>{index + 1}</td>
                    <td
                      className="trainee-name-clickable"
                      onClick={() => trainee && handleTraineeClick(trainee)}
                    >
                      {warning.traineeName}
                    </td>
                    <td>{warning.instructorName}</td>
                    <td>{warning.vehiclePlate}</td>
                    <td>{formatDateTimeUTC7(warning.startTime)}</td>
                    <td>{formatDateTimeUTC7(warning.endTime)}</td>
                    <td className="warning-duration">{Math.round(warning.duration)} phút</td>
                    <td>
                      {warning.startLat && warning.startLng
                        ? `${warning.startLat.toFixed(6)}, ${warning.startLng.toFixed(6)}`
                        : 'N/A'}
                    </td>
                    <td>
                      <button
                        className="view-warning-btn"
                        onClick={() => trainee && handleTraineeClick(trainee)}
                      >
                        📋 Xem
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showPopup && selectedTrainee && (
        <div className="popup-overlay">
          <div className="popup-content" ref={popupRef}>
            <div className="popup-header">
              <h2>📋 Chi tiết Outdoor Sessions</h2>
              <button className="popup-close" onClick={closePopup}>
                ✕
              </button>
            </div>

            <div className="popup-trainee-info">
              <h3>Thông tin học viên</h3>
              <p>
                <strong>Họ và tên:</strong> {getTraineeName(selectedTrainee)}
              </p>
              <p>
                <strong>ID:</strong> {selectedTrainee.id}
              </p>
            </div>

            {!loadingSessions &&
              outdoorSessions.length > 0 &&
              Object.keys(sessionSummary).length > 0 && (
                <div className="popup-total-summary">
                  <h3>📊 Tổng hợp tất cả các buổi học</h3>
                  {(() => {
                    const total = calculateTotalSummary();
                    return (
                      <div className="summary-grid">
                        <div className="summary-item">
                          <span className="summary-label">Tổng thời gian:</span>
                          <span className="summary-value">{formatDuration(total.totalTime)}</span>
                        </div>
                        <div className="summary-item">
                          <span className="summary-label">Tổng quãng đường:</span>
                          <span className="summary-value">
                            {formatDistance(total.totalDistance)}
                          </span>
                        </div>
                        <div className="summary-item night">
                          <span className="summary-label">🌙 Thời gian ban đêm:</span>
                          <span className="summary-value">
                            {formatNightDuration(total.nightTime)}
                          </span>
                        </div>
                        <div className="summary-item night">
                          <span className="summary-label">🌙 Quãng đường ban đêm:</span>
                          <span className="summary-value">
                            {formatDistance(total.nightDistance)}
                          </span>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}

            <div className="popup-sessions">
              <h3>🚗 Danh sách Outdoor Sessions</h3>
              {loadingSessions ? (
                <div className="loading-sessions">Đang tải dữ liệu...</div>
              ) : outdoorSessions.length > 0 ? (
                <div>
                  <div className="sessions-table-wrapper">
                    <table className="sessions-summary-table">
                      <thead>
                        <tr>
                          <th>STT</th>
                          <th>Giáo viên</th>
                          <th>Xe</th>
                          <th>Hạng xe</th>
                          <th>Start Time</th>
                          <th>End Time</th>
                          <th>Thời gian</th>
                          <th>Quãng đường</th>
                          <th>🌙 Thời gian đêm</th>
                          <th>🌙 Quãng đường đêm</th>
                          <th>Trạng thái</th>
                          <th>Cảnh báo</th>
                        </tr>
                      </thead>
                      <tbody>
                        {outdoorSessions.map((session, index) => {
                          const summary = sessionSummary[session.id] || {
                            totalDistance: 0,
                            totalTime: 0,
                            nightDistance: 0,
                            nightTime: 0,
                            totalRecords: 0,
                            nightRecords: 0,
                          };
                          const warnings = sessionWarnings[session.id] || [];
                          return (
                            <tr
                              key={session.id || index}
                              className={warnings.length > 0 ? 'has-warning' : ''}
                            >
                              <td>{index + 1}</td>
                              <td>{session.instructor_name || 'Không có'}</td>
                              <td>{session.vehicle_plate || 'Không có'}</td>
                              <td>{getVehicle(session)}</td>
                              <td>{formatDateTimeDisplay(session.start_time)}</td>
                              <td>{formatDateTimeDisplay(session.end_time)}</td>
                              <td>{formatDuration(summary.totalTime)}</td>
                              <td>{formatDistance(summary.totalDistance)}</td>
                              <td className="night-cell">
                                {formatNightDuration(summary.nightTime)}
                              </td>
                              <td className="night-cell">
                                {formatDistance(summary.nightDistance)}
                              </td>
                              <td>{getSyncedStatus(session)}</td>
                              <td>
                                {warnings.length > 0 ? (
                                  <span
                                    className="warning-badge"
                                    title={`${warnings.length} cảnh báo`}
                                  >
                                    ⚠️ {warnings.length}
                                  </span>
                                ) : (
                                  <span className="no-warning">✅</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {Object.keys(sessionWarnings).some(
                    (k) => sessionWarnings[k].length > 0
                  ) && (
                    <div className="warnings-details">
                      <h4>⚠️ Chi tiết cảnh báo dừng xe (Vận tốc = 0 liên tiếp &gt; 10 phút)</h4>
                      {outdoorSessions.map((session, index) => {
                        const warnings = sessionWarnings[session.id] || [];
                        if (warnings.length === 0) return null;
                        return (
                          <div key={session.id} className="warning-session">
                            <h5>
                              Session #{index + 1} - Xe: {session.vehicle_plate || 'Không có'}
                            </h5>
                            <table className="warning-table">
                              <thead>
                                <tr>
                                  <th>STT</th>
                                  <th>Thời gian bắt đầu</th>
                                  <th>Thời gian kết thúc</th>
                                  <th>Thời gian dừng</th>
                                  <th>Vị trí bắt đầu</th>
                                  <th>Vị trí kết thúc</th>
                                  <th>Ghi chú</th>
                                </tr>
                              </thead>
                              <tbody>
                                {warnings.map((warning, idx) => (
                                  <tr key={idx}>
                                    <td>{idx + 1}</td>
                                    <td>{formatDateTimeUTC7(warning.startTime)}</td>
                                    <td>{formatDateTimeUTC7(warning.endTime)}</td>
                                    <td className="warning-duration">
                                      {Math.round(warning.duration)} phút
                                    </td>
                                    <td>
                                      {warning.startLat && warning.startLng
                                        ? `${warning.startLat.toFixed(6)}, ${warning.startLng.toFixed(6)}`
                                        : 'N/A'}
                                    </td>
                                    <td>
                                      {warning.endLat && warning.endLng
                                        ? `${warning.endLat.toFixed(6)}, ${warning.endLng.toFixed(6)}`
                                        : 'N/A'}
                                    </td>
                                    <td>{warning.note || '-'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : (
                <div className="no-sessions">
                  <p>Không có outdoor sessions nào cho học viên này</p>
                </div>
              )}
            </div>

            <div className="popup-footer">
              <button className="close-popup-btn" onClick={closePopup}>
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ToolDat;