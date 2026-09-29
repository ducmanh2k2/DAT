// utils/helpers.js
export const getCourseName = (course) => {
  return course.ten_khoa_hoc || course.ten_so_gtvt || course.name || course.course_name || 'Không có tên';
};

export const getTraineeName = (trainee) => {
  return trainee.ho_va_ten || trainee.name || trainee.full_name || trainee.fullname || 'Không có tên';
};

export const formatDate = (dateString) => {
  if (!dateString) return 'Không có';
  try {
    const date = new Date(dateString);
    return date.toLocaleString('vi-VN');
  } catch {
    return dateString;
  }
};

export const extractDataFromResponse = (response) => {
  let data = [];
  if (Array.isArray(response)) {
    data = response;
  } else if (response.data && Array.isArray(response.data)) {
    data = response.data;
  } else if (response.items && Array.isArray(response.items)) {
    data = response.items;
  } else if (response.rows && Array.isArray(response.rows)) {
    data = response.rows;
  }
  return data;
};