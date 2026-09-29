// services/apiService.js
import axios from 'axios';

const API_BASE_URL = 'https://jira.shlx.vn/v1';
const S3_BASE_URL = 'https://s3-north1.viettelidc.com.vn/tp-shlx-data';

class ApiService {
  constructor() {
    this.token = null;
  }

  async login(email = "doluong@shlx.vn", password = "123456") {
    try {
      const response = await axios.post(`${API_BASE_URL}/login`, {
        email,
        password
      });
      
      let tokenValue = null;
      if (response.data.token) {
        tokenValue = response.data.token;
      } else if (response.data.access_token) {
        tokenValue = response.data.access_token;
      } else if (response.data.data && response.data.data.token) {
        tokenValue = response.data.data.token;
      } else if (response.data.data && response.data.data.access_token) {
        tokenValue = response.data.data.access_token;
      }

      if (tokenValue) {
        this.token = tokenValue;
        return tokenValue;
      }
      throw new Error('Không lấy được token');
    } catch (err) {
      throw new Error('Đăng nhập thất bại: ' + err.message);
    }
  }

  async getCourses() {
    try {
      if (!this.token) {
        await this.login();
      }

      const response = await axios.get(
        `${API_BASE_URL}/courses?ma=&name=&page=1&page_size=50&status=-1`,
        {
          headers: {
            'Authorization': `Bearer ${this.token}`
          }
        }
      );

      let coursesData = [];
      if (Array.isArray(response.data)) {
        coursesData = response.data;
      } else if (response.data.data && Array.isArray(response.data.data)) {
        coursesData = response.data.data;
      } else if (response.data.items && Array.isArray(response.data.items)) {
        coursesData = response.data.items;
      } else if (response.data.rows && Array.isArray(response.data.rows)) {
        coursesData = response.data.rows;
      }

      return coursesData;
    } catch (err) {
      throw new Error('Lỗi khi lấy danh sách khóa học: ' + err.message);
    }
  }

  async getTraineesByCourseId(courseId) {
    try {
      if (!this.token) {
        await this.login();
      }

      const response = await axios.get(
        `${API_BASE_URL}/trainees?course_id=${courseId}&name=&id_card=&rf_card=&rf_card_name=&synced=-1&face=-1&page=1&status=-1`,
        {
          headers: {
            'Authorization': `Bearer ${this.token}`
          }
        }
      );

      let traineesData = [];
      if (Array.isArray(response.data)) {
        traineesData = response.data;
      } else if (response.data.data && Array.isArray(response.data.data)) {
        traineesData = response.data.data;
      } else if (response.data.items && Array.isArray(response.data.items)) {
        traineesData = response.data.items;
      } else if (response.data.rows && Array.isArray(response.data.rows)) {
        traineesData = response.data.rows;
      }

      return traineesData;
    } catch (err) {
      throw new Error('Lỗi khi lấy danh sách học viên: ' + err.message);
    }
  }

  async getOutdoorSessions(traineeId) {
    try {
      if (!this.token) {
        await this.login();
      }

      const response = await axios.get(
        `${API_BASE_URL}/trainees/${traineeId}/outdoor-sessions?mark=1`,
        {
          headers: {
            'Authorization': `Bearer ${this.token}`
          }
        }
      );

      let sessionsData = [];
      if (Array.isArray(response.data)) {
        sessionsData = response.data;
      } else if (response.data.data && Array.isArray(response.data.data)) {
        sessionsData = response.data.data;
      } else if (response.data.items && Array.isArray(response.data.items)) {
        sessionsData = response.data.items;
      } else if (response.data.rows && Array.isArray(response.data.rows)) {
        sessionsData = response.data.rows;
      }

      return sessionsData;
    } catch (err) {
      throw new Error('Lỗi khi lấy outdoor sessions: ' + err.message);
    }
  }

  async fetchArchivedDetails(archivedUrl) {
    if (!archivedUrl) return null;
    
    try {
      console.log(`📡 Đang lấy dữ liệu từ: ${S3_BASE_URL}/${archivedUrl}`);
      
      const response = await axios.get(`${S3_BASE_URL}/${archivedUrl}`);
      console.log("📡 Response từ S3:", response.data);
      
      let details = [];
      if (Array.isArray(response.data)) {
        details = response.data;
      } else if (response.data.data && Array.isArray(response.data.data)) {
        details = response.data.data;
      } else if (response.data.items && Array.isArray(response.data.items)) {
        details = response.data.items;
      } else if (response.data.rows && Array.isArray(response.data.rows)) {
        details = response.data.rows;
      }
      
      return details;
    } catch (err) {
      console.error("❌ Lỗi lấy dữ liệu archived:", err);
      return null;
    }
  }
}

export default new ApiService();