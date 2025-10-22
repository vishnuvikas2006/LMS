const express = require("express");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const cors = require("cors");
const fs = require("fs");
const multer = require("multer");
const http = require("http");
const socketIo = require("socket.io");
const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = "eduportal";
let db, client;

async function connectDB() {
  try {
    // Connect with SSL/TLS and proper options
    client = new MongoClient(MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      tls: true, // ensure TLS
      tlsAllowInvalidCertificates: false, // should be false for Atlas
    });

    await client.connect();
    db = client.db(DB_NAME);

    console.log("✅ Connected to MongoDB successfully");

    // Create indexes
    await db.collection("users").createIndex({ email: 1 }, { unique: true });
    await db
      .collection("attendance")
      .createIndex({ studentEmail: 1, course: 1, date: 1 });
    await db
      .collection("leaderboard")
      .createIndex({ month: 1, year: 1 }, { unique: true });

    return db;
  } catch (error) {
    console.error("❌ MongoDB connection error:", error);
    process.exit(1);
  }
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(express.static("."));
app.use("/uploads", express.static("uploads"));

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync("uploads")) {
      fs.mkdirSync("uploads");
    }
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + file.originalname);
  },
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
});

// AI Chatbot responses
const chatbotResponses = {
  portal:
    "EduPortal is a comprehensive student and teacher management system that helps manage academic activities, track progress, and facilitate communication between students, teachers, and parents.",
  system:
    "The EduPortal system provides features for course management, attendance tracking, assignment submission, grade management, live meetings, and communication between all stakeholders.",
  feature:
    "The portal offers course enrollment, attendance tracking, assignment management, grade viewing, live meetings, previous question papers, discussion forums, and parent-teacher communication.",
  course:
    "You can browse and enroll in available courses. Once enrolled, you can access course materials, video resources, and participate in course discussions.",
  attendance:
    "Attendance records show your class participation percentage for each course. Teachers mark attendance, and you can view your attendance statistics.",
  assignment:
    "Assignments are posted by teachers with due dates. You can submit your work through the Assignments section before the deadline.",
  grade:
    "Grades are assigned by teachers for assignments and exams. You can view your grades and overall performance in the Results section.",
  meeting:
    "Teachers can conduct live meetings for enrolled students. You will receive meeting invitations that you can join through the Live Meetings section.",
  paper:
    "Previous question papers are uploaded by teachers and can be accessed in the Previous Papers section for exam preparation.",
  forum:
    "The discussion forum allows you to ask questions and participate in course-related discussions with teachers and other students.",
  timetable:
    "Your class timetable shows your daily or weekly class schedule organized by your department.",
  notification:
    "You receive notifications for important updates like new assignments, grade postings, meeting invitations, and system announcements.",
  complaint:
    "You can raise complaints through the Raise Complaint section. Your concerns will be reviewed by the administration.",
  leave:
    "You can request leave through the Request Leave section. Approved leaves will not affect your attendance record.",
  leaderboard:
    "The monthly leaderboard showcases top-performing students. Students earn performance credits when they appear on the leaderboard.",
  default:
    "I'm here to help you with information about the EduPortal system. You can ask me about courses, attendance, assignments, grades, live meetings, previous papers, or any other features.",
};

// Socket.io for real-time features
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("join-user", (userEmail) => {
    socket.join(userEmail);
  });

  socket.on("join-chat", (data) => {
    socket.join(`chat-${data.parentEmail}-${data.teacherEmail}`);
  });

  socket.on("send-chat-message", async (data) => {
    const chatId = `chat-${data.parentEmail}-${data.teacherEmail}`;
    const message = {
      id: uuidv4(),
      parentEmail: data.parentEmail,
      teacherEmail: data.teacherEmail,
      message: data.message,
      sender: data.sender,
      timestamp: new Date().toISOString(),
    };

    await db.collection("chatMessages").insertOne(message);
    io.to(chatId).emit("new-chat-message", message);
  });

  socket.on("user-online", (data) => {
    // Add user to online list
    socket.broadcast.emit("user-online", data);
  });

  socket.on("user-offline", (data) => {
    // Notify others when user goes offline
    socket.broadcast.emit("user-offline", data);
  });

  socket.on("meeting-invitation", (data) => {
    // Send meeting invitation to student
    io.to(data.studentEmail).emit("meeting-invitation", data);

    // Also send as notification
    sendNotification(
      data.studentEmail,
      "Live Meeting Invitation",
      `You have been invited to a live meeting for ${data.course} by ${data.teacher}.`,
      "info"
    );
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

// Helper function to send notifications
async function sendNotification(userEmail, title, message, type = "info") {
  const notification = {
    id: uuidv4(),
    userEmail,
    title,
    message,
    type,
    read: false,
    timestamp: new Date().toISOString(),
  };

  await db.collection("notifications").insertOne(notification);
  io.to(userEmail).emit("notification", notification);
}

// Routes

// User Registration with Photo Upload - FIXED
app.post("/api/register", upload.single("photo"), async (req, res) => {
  try {
    const {
      type,
      email,
      password,
      name,
      department,
      subject,
      fatherName,
      rollNumber,
      parentEmail,
      parentPassword,
    } = req.body;

    // Check if user already exists
    const existingUser = await db.collection("users").findOne({ email });
    if (existingUser) {
      return res.json({
        success: false,
        message: "User already exists with this email",
      });
    }

    // Generate roll number if not provided for students
    let finalRollNumber = rollNumber;
    if (type === "student" && !rollNumber) {
      const studentsInDept = await db.collection("users").countDocuments({
        type: "student",
        department: department,
      });
      finalRollNumber = `${department.substring(0, 3).toUpperCase()}${(
        studentsInDept + 1
      )
        .toString()
        .padStart(3, "0")}`;
    }

    const user = {
      id: uuidv4(),
      type,
      email,
      password,
      name,
      department,
      rollNumber: type === "student" ? finalRollNumber : null,
      subject: type === "teacher" ? subject : null,
      fatherName: type === "student" ? fatherName : null,
      photo: req.file ? `/uploads/${req.file.filename}` : null,
      performanceCredits: type === "student" ? 0 : 0,
      registrationDate: new Date().toISOString(),
    };

    await db.collection("users").insertOne(user);

    // Create parent account for student if provided
    if (type === "student" && parentEmail && parentPassword) {
      // Check if parent email already exists
      const existingParent = await db
        .collection("users")
        .findOne({ email: parentEmail });
      if (!existingParent) {
        const parent = {
          id: uuidv4(),
          type: "parent",
          email: parentEmail,
          password: parentPassword,
          name: `${fatherName} (Parent)`,
          studentEmail: email,
          registrationDate: new Date().toISOString(),
        };
        await db.collection("users").insertOne(parent);
      }
    }

    res.json({ success: true, message: "Registration successful" });
  } catch (error) {
    console.error("Registration error:", error);
    res.json({
      success: false,
      message: "Registration failed: " + error.message,
    });
  }
});

// User Login - FIXED
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.json({
        success: false,
        message: "Email and password are required",
      });
    }

    const user = await db
      .collection("users")
      .findOne({ email: email, password: password });

    if (user) {
      // Don't send password back
      const { password, ...userWithoutPassword } = user;
      res.json({ success: true, user: userWithoutPassword });
    } else {
      res.json({ success: false, message: "Invalid email or password" });
    }
  } catch (error) {
    console.error("Login error:", error);
    res.json({ success: false, message: "Login failed: " + error.message });
  }
});

// Get User Profile
app.get("/api/profile/:email", async (req, res) => {
  try {
    const user = await db
      .collection("users")
      .findOne({ email: req.params.email });
    if (user) {
      const { password, ...userWithoutPassword } = user;
      res.json({ success: true, user: userWithoutPassword });
    } else {
      res.json({ success: false, message: "User not found" });
    }
  } catch (error) {
    res.json({
      success: false,
      message: "Error fetching profile: " + error.message,
    });
  }
});

// Course Management
app.post("/api/courses", upload.array("files", 10), async (req, res) => {
  try {
    const { teacherEmail, courseName, description, department, duration } =
      req.body;

    const course = {
      id: uuidv4(),
      teacherEmail,
      courseName,
      description,
      department,
      duration: duration || "1 semester",
      files: req.files
        ? req.files.map((file) => ({
            name: file.originalname,
            url: `/uploads/${file.filename}`,
            uploadedDate: new Date().toISOString(),
          }))
        : [],
      createdDate: new Date().toISOString(),
    };

    await db.collection("courses").insertOne(course);

    // Notify students in the same department
    const departmentStudents = await db
      .collection("users")
      .find({
        type: "student",
        department: department,
      })
      .toArray();

    departmentStudents.forEach((student) => {
      sendNotification(
        student.email,
        "New Course Available",
        `A new course "${courseName}" has been added to your department.`,
        "info"
      );
    });

    res.json({ success: true, message: "Course created successfully" });
  } catch (error) {
    res.json({
      success: false,
      message: "Course creation failed: " + error.message,
    });
  }
});

app.get("/api/courses/:department", async (req, res) => {
  try {
    const departmentCourses = await db
      .collection("courses")
      .find({
        department: req.params.department,
      })
      .toArray();
    res.json({ success: true, courses: departmentCourses });
  } catch (error) {
    res.json({
      success: false,
      message: "Error fetching courses: " + error.message,
    });
  }
});

app.get("/api/all-courses", async (req, res) => {
  try {
    const courses = await db.collection("courses").find({}).toArray();
    res.json({ success: true, courses: courses });
  } catch (error) {
    res.json({
      success: false,
      message: "Error fetching courses: " + error.message,
    });
  }
});

// Course Enrollment
app.post("/api/enroll", async (req, res) => {
  try {
    const { studentEmail, courseId } = req.body;

    // Check if already enrolled
    const existingEnrollment = await db.collection("enrollments").findOne({
      studentEmail,
      courseId,
    });

    if (existingEnrollment) {
      return res.json({
        success: false,
        message: "Already enrolled in this course",
      });
    }

    const enrollment = {
      id: uuidv4(),
      studentEmail,
      courseId,
      enrolledDate: new Date().toISOString(),
    };

    await db.collection("enrollments").insertOne(enrollment);

    // Notify teacher
    const course = await db.collection("courses").findOne({ id: courseId });
    if (course) {
      sendNotification(
        course.teacherEmail,
        "New Student Enrollment",
        `A student has enrolled in your course "${course.courseName}".`,
        "info"
      );
    }

    res.json({ success: true, message: "Enrolled successfully" });
  } catch (error) {
    res.json({
      success: false,
      message: "Enrollment failed: " + error.message,
    });
  }
});

app.get("/api/enrolled-courses/:studentEmail", async (req, res) => {
  try {
    const studentEnrollments = await db
      .collection("enrollments")
      .find({
        studentEmail: req.params.studentEmail,
      })
      .toArray();

    const enrolledCourses = await Promise.all(
      studentEnrollments.map(async (enrollment) => {
        const course = await db
          .collection("courses")
          .findOne({ id: enrollment.courseId });
        return course
          ? {
              ...course,
              enrolledDate: enrollment.enrolledDate,
            }
          : null;
      })
    );

    res.json({ success: true, courses: enrolledCourses.filter(Boolean) });
  } catch (error) {
    res.json({
      success: false,
      message: "Error fetching enrolled courses: " + error.message,
    });
  }
});

app.get("/api/course-students/:courseId", async (req, res) => {
  try {
    const courseEnrollments = await db
      .collection("enrollments")
      .find({
        courseId: req.params.courseId,
      })
      .toArray();

    const students = await Promise.all(
      courseEnrollments.map(async (enrollment) => {
        const user = await db
          .collection("users")
          .findOne({ email: enrollment.studentEmail });
        return user
          ? {
              name: user.name,
              email: user.email,
              rollNumber: user.rollNumber,
              photo: user.photo,
              enrolledDate: enrollment.enrolledDate,
            }
          : null;
      })
    );

    res.json({ success: true, students: students.filter(Boolean) });
  } catch (error) {
    res.json({
      success: false,
      message: "Error fetching course students: " + error.message,
    });
  }
});

// Attendance Management
app.post("/api/attendance", async (req, res) => {
  try {
    const { teacherEmail, studentEmail, course, date, status } = req.body;

    // Check if attendance already exists for this student, course, and date
    const existingRecord = await db.collection("attendance").findOne({
      studentEmail,
      course,
      date,
    });

    if (existingRecord) {
      // Update existing record
      await db.collection("attendance").updateOne(
        { _id: existingRecord._id },
        {
          $set: {
            status: status,
            updatedDate: new Date().toISOString(),
          },
        }
      );
      res.json({ success: true, message: "Attendance updated successfully" });
    } else {
      // Create new record
      const attendanceRecord = {
        id: uuidv4(),
        teacherEmail,
        studentEmail,
        course,
        date,
        status,
        recordedDate: new Date().toISOString(),
      };
      await db.collection("attendance").insertOne(attendanceRecord);
      res.json({ success: true, message: "Attendance recorded successfully" });
    }
  } catch (error) {
    res.json({
      success: false,
      message: "Attendance recording failed: " + error.message,
    });
  }
});

app.get("/api/attendance/:studentEmail", async (req, res) => {
  try {
    const studentAttendance = await db
      .collection("attendance")
      .find({
        studentEmail: req.params.studentEmail,
      })
      .toArray();
    res.json({ success: true, attendance: studentAttendance });
  } catch (error) {
    res.json({
      success: false,
      message: "Error fetching attendance: " + error.message,
    });
  }
});

// Grade Management
app.post("/api/grades", async (req, res) => {
  try {
    const {
      teacherEmail,
      studentEmail,
      course,
      grade,
      semester,
      assignmentId,
    } = req.body;

    // Check if grade already exists for this student and course
    const existingGrade = await db.collection("grades").findOne({
      studentEmail,
      course,
      semester,
      assignmentId,
    });

    if (existingGrade) {
      // Update existing grade
      await db.collection("grades").updateOne(
        { _id: existingGrade._id },
        {
          $set: {
            grade: grade,
            updatedDate: new Date().toISOString(),
          },
        }
      );

      // Notify student
      sendNotification(
        studentEmail,
        "Grade Updated",
        `Your grade for ${course} has been updated to ${grade}.`,
        "info"
      );

      res.json({ success: true, message: "Grade updated successfully" });
    } else {
      // Create new grade
      const gradeRecord = {
        id: uuidv4(),
        teacherEmail,
        studentEmail,
        course,
        grade,
        semester,
        assignmentId,
        uploadedDate: new Date().toISOString(),
      };
      await db.collection("grades").insertOne(gradeRecord);

      // Notify student
      sendNotification(
        studentEmail,
        "New Grade Available",
        `You have received a grade for ${course}: ${grade}.`,
        "info"
      );

      res.json({ success: true, message: "Grade uploaded successfully" });
    }
  } catch (error) {
    res.json({
      success: false,
      message: "Grade upload failed: " + error.message,
    });
  }
});

app.get("/api/grades/:studentEmail", async (req, res) => {
  try {
    const studentGrades = await db
      .collection("grades")
      .find({
        studentEmail: req.params.studentEmail,
      })
      .toArray();
    res.json({ success: true, grades: studentGrades });
  } catch (error) {
    res.json({
      success: false,
      message: "Error fetching grades: " + error.message,
    });
  }
});

// Calculate overall grades
app.get("/api/overall-grades/:studentEmail", async (req, res) => {
  try {
    const studentGrades = await db
      .collection("grades")
      .find({
        studentEmail: req.params.studentEmail,
      })
      .toArray();

    // Calculate average grade per course
    const courseGrades = {};
    studentGrades.forEach((grade) => {
      if (!courseGrades[grade.course]) {
        courseGrades[grade.course] = {
          grades: [],
          average: 0,
        };
      }

      // Convert letter grade to numerical value for calculation
      const gradeValue = convertGradeToNumber(grade.grade);
      courseGrades[grade.course].grades.push(gradeValue);
    });

    // Calculate averages
    Object.keys(courseGrades).forEach((course) => {
      const grades = courseGrades[course].grades;
      const average =
        grades.reduce((sum, grade) => sum + grade, 0) / grades.length;
      courseGrades[course].average = convertNumberToGrade(average);
    });

    res.json({ success: true, overallGrades: courseGrades });
  } catch (error) {
    res.json({
      success: false,
      message: "Error calculating overall grades: " + error.message,
    });
  }
});

function convertGradeToNumber(grade) {
  const gradeMap = {
    "A+": 4.3,
    A: 4.0,
    "A-": 3.7,
    "B+": 3.3,
    B: 3.0,
    "B-": 2.7,
    "C+": 2.3,
    C: 2.0,
    "C-": 1.7,
    D: 1.0,
    F: 0.0,
  };
  return gradeMap[grade] || 0;
}

function convertNumberToGrade(number) {
  if (number >= 4.0) return "A";
  if (number >= 3.7) return "A-";
  if (number >= 3.3) return "B+";
  if (number >= 3.0) return "B";
  if (number >= 2.7) return "B-";
  if (number >= 2.3) return "C+";
  if (number >= 2.0) return "C";
  if (number >= 1.7) return "C-";
  if (number >= 1.0) return "D";
  return "F";
}

// Assignment Management
app.post("/api/assignments", upload.array("files", 10), async (req, res) => {
  try {
    const { teacherEmail, title, description, dueDate, course, department } =
      req.body;

    const assignment = {
      id: uuidv4(),
      teacherEmail,
      title,
      description,
      dueDate,
      course,
      department,
      files: req.files
        ? req.files.map((file) => ({
            name: file.originalname,
            url: `/uploads/${file.filename}`,
            uploadedDate: new Date().toISOString(),
          }))
        : [],
      createdDate: new Date().toISOString(),
    };

    await db.collection("assignments").insertOne(assignment);

    // Notify enrolled students
    const courseObj = await db
      .collection("courses")
      .findOne({ courseName: course });
    if (courseObj) {
      const courseEnrollments = await db
        .collection("enrollments")
        .find({
          courseId: courseObj.id,
        })
        .toArray();

      courseEnrollments.forEach((enrollment) => {
        sendNotification(
          enrollment.studentEmail,
          "New Assignment",
          `A new assignment "${title}" has been posted for ${course}. Due date: ${dueDate}`,
          "warning"
        );
      });
    }

    res.json({ success: true, message: "Assignment uploaded successfully" });
  } catch (error) {
    res.json({
      success: false,
      message: "Assignment upload failed: " + error.message,
    });
  }
});

app.get("/api/assignments/:department", async (req, res) => {
  try {
    const departmentAssignments = await db
      .collection("assignments")
      .find({
        department: req.params.department,
      })
      .toArray();
    res.json({ success: true, assignments: departmentAssignments });
  } catch (error) {
    res.json({
      success: false,
      message: "Error fetching assignments: " + error.message,
    });
  }
});

// Assignment Submission
app.post("/api/submit-assignment", upload.single("file"), async (req, res) => {
  try {
    const { assignmentId, studentEmail } = req.body;

    const submission = {
      id: uuidv4(),
      assignmentId,
      studentEmail,
      file: req.file
        ? {
            name: req.file.originalname,
            url: `/uploads/${req.file.filename}`,
            uploadedDate: new Date().toISOString(),
          }
        : null,
      submittedDate: new Date().toISOString(),
      status: "submitted",
    };

    await db.collection("assignmentSubmissions").insertOne(submission);

    // Notify teacher
    const assignment = await db
      .collection("assignments")
      .findOne({ id: assignmentId });
    if (assignment) {
      sendNotification(
        assignment.teacherEmail,
        "Assignment Submitted",
        `A student has submitted the assignment "${assignment.title}".`,
        "info"
      );
    }

    res.json({ success: true, message: "Assignment submitted successfully" });
  } catch (error) {
    res.json({
      success: false,
      message: "Assignment submission failed: " + error.message,
    });
  }
});

app.get("/api/assignment-submissions/:assignmentId", async (req, res) => {
  try {
    const assignmentSubs = await db
      .collection("assignmentSubmissions")
      .find({
        assignmentId: req.params.assignmentId,
      })
      .toArray();
    res.json({ success: true, submissions: assignmentSubs });
  } catch (error) {
    res.json({
      success: false,
      message: "Error fetching assignment submissions: " + error.message,
    });
  }
});

// Forum Management
app.post("/api/forum-posts", async (req, res) => {
  try {
    const { userEmail, courseId, title, content } = req.body;

    const post = {
      id: uuidv4(),
      userEmail,
      courseId,
      title,
      content,
      replies: [],
      createdDate: new Date().toISOString(),
    };

    await db.collection("forumPosts").insertOne(post);

    // Notify course participants
    const courseEnrollments = await db
      .collection("enrollments")
      .find({
        courseId: courseId,
      })
      .toArray();

    courseEnrollments.forEach((enrollment) => {
      if (enrollment.studentEmail !== userEmail) {
        sendNotification(
          enrollment.studentEmail,
          "New Forum Post",
          `A new discussion has been started in your course forum: "${title}"`,
          "info"
        );
      }
    });

    res.json({ success: true, message: "Post created successfully" });
  } catch (error) {
    res.json({
      success: false,
      message: "Forum post creation failed: " + error.message,
    });
  }
});

app.post("/api/forum-replies", async (req, res) => {
  try {
    const { postId, userEmail, content } = req.body;

    const post = await db.collection("forumPosts").findOne({ id: postId });
    if (post) {
      const reply = {
        id: uuidv4(),
        userEmail,
        content,
        createdDate: new Date().toISOString(),
      };

      await db
        .collection("forumPosts")
        .updateOne({ id: postId }, { $push: { replies: reply } });

      // Notify post author
      if (post.userEmail !== userEmail) {
        sendNotification(
          post.userEmail,
          "New Forum Reply",
          `Someone replied to your post: "${post.title}"`,
          "info"
        );
      }

      res.json({ success: true, message: "Reply posted successfully" });
    } else {
      res.json({ success: false, message: "Post not found" });
    }
  } catch (error) {
    res.json({
      success: false,
      message: "Forum reply failed: " + error.message,
    });
  }
});

app.get("/api/forum-posts/:courseId", async (req, res) => {
  try {
    const coursePosts = await db
      .collection("forumPosts")
      .find({
        courseId: req.params.courseId,
      })
      .toArray();
    res.json({ success: true, posts: coursePosts });
  } catch (error) {
    res.json({
      success: false,
      message: "Error fetching forum posts: " + error.message,
    });
  }
});

// Leave Management
app.post("/api/leave", async (req, res) => {
  try {
    const { userEmail, type, startDate, endDate, reason } = req.body;

    const leaveRequest = {
      id: uuidv4(),
      userEmail,
      type,
      startDate,
      endDate,
      reason,
      status: "pending",
      submittedDate: new Date().toISOString(),
    };

    await db.collection("leaveRequests").insertOne(leaveRequest);

    // Notify relevant teachers
    if (type === "student") {
      const student = await db
        .collection("users")
        .findOne({ email: userEmail });
      if (student) {
        const departmentTeachers = await db
          .collection("users")
          .find({
            type: "teacher",
            department: student.department,
          })
          .toArray();

        departmentTeachers.forEach((teacher) => {
          sendNotification(
            teacher.email,
            "New Leave Request",
            `A student has submitted a leave request.`,
            "info"
          );
        });
      }
    }

    res.json({
      success: true,
      message: "Leave request submitted successfully",
    });
  } catch (error) {
    res.json({
      success: false,
      message: "Leave request failed: " + error.message,
    });
  }
});

app.get("/api/leave-requests/:department", async (req, res) => {
  try {
    const departmentStudents = await db
      .collection("users")
      .find({
        type: "student",
        department: req.params.department,
      })
      .toArray();

    const studentEmails = departmentStudents.map((student) => student.email);
    const departmentLeaveRequests = await db
      .collection("leaveRequests")
      .find({
        userEmail: { $in: studentEmails },
        status: "pending",
      })
      .toArray();

    res.json({ success: true, leaveRequests: departmentLeaveRequests });
  } catch (error) {
    res.json({
      success: false,
      message: "Error fetching leave requests: " + error.message,
    });
  }
});

app.post("/api/leave-status", async (req, res) => {
  try {
    const { leaveId, status } = req.body;

    const leaveRequest = await db
      .collection("leaveRequests")
      .findOne({ id: leaveId });
    if (leaveRequest) {
      await db.collection("leaveRequests").updateOne(
        { id: leaveId },
        {
          $set: {
            status: status,
            processedDate: new Date().toISOString(),
          },
        }
      );

      // Notify student
      sendNotification(
        leaveRequest.userEmail,
        "Leave Request Update",
        `Your leave request has been ${status}.`,
        status === "approved" ? "success" : "warning"
      );

      res.json({
        success: true,
        message: "Leave request updated successfully",
      });
    } else {
      res.json({ success: false, message: "Leave request not found" });
    }
  } catch (error) {
    res.json({
      success: false,
      message: "Leave status update failed: " + error.message,
    });
  }
});

// Complaint Management
app.post("/api/complaint", async (req, res) => {
  try {
    const { studentEmail, title, description, category } = req.body;

    const complaint = {
      id: uuidv4(),
      studentEmail,
      title,
      description,
      category,
      status: "open",
      submittedDate: new Date().toISOString(),
    };

    await db.collection("complaints").insertOne(complaint);

    // Notify department teachers
    const student = await db
      .collection("users")
      .findOne({ email: studentEmail });
    if (student) {
      const departmentTeachers = await db
        .collection("users")
        .find({
          type: "teacher",
          department: student.department,
        })
        .toArray();

      departmentTeachers.forEach((teacher) => {
        sendNotification(
          teacher.email,
          "New Complaint",
          `A new complaint has been submitted in your department.`,
          "warning"
        );
      });
    }

    res.json({ success: true, message: "Complaint submitted successfully" });
  } catch (error) {
    res.json({
      success: false,
      message: "Complaint submission failed: " + error.message,
    });
  }
});

app.get("/api/complaints/:department", async (req, res) => {
  try {
    const departmentStudents = await db
      .collection("users")
      .find({
        type: "student",
        department: req.params.department,
      })
      .toArray();

    const studentEmails = departmentStudents.map((student) => student.email);
    const departmentComplaints = await db
      .collection("complaints")
      .find({
        studentEmail: { $in: studentEmails },
      })
      .toArray();

    res.json({ success: true, complaints: departmentComplaints });
  } catch (error) {
    res.json({
      success: false,
      message: "Error fetching complaints: " + error.message,
    });
  }
});

app.post("/api/complaint-status", async (req, res) => {
  try {
    const { complaintId, status } = req.body;

    const complaint = await db
      .collection("complaints")
      .findOne({ id: complaintId });
    if (complaint) {
      await db.collection("complaints").updateOne(
        { id: complaintId },
        {
          $set: {
            status: status,
            updatedDate: new Date().toISOString(),
          },
        }
      );

      // Notify student
      sendNotification(
        complaint.studentEmail,
        "Complaint Status Update",
        `Your complaint status has been updated to ${status}.`,
        "info"
      );

      res.json({
        success: true,
        message: "Complaint status updated successfully",
      });
    } else {
      res.json({ success: false, message: "Complaint not found" });
    }
  } catch (error) {
    res.json({
      success: false,
      message: "Complaint status update failed: " + error.message,
    });
  }
});

// Student Management
app.get("/api/students/:department", async (req, res) => {
  try {
    const departmentStudents = await db
      .collection("users")
      .find({
        type: "student",
        department: req.params.department,
      })
      .toArray();

    // Remove passwords from response
    const studentsWithoutPasswords = departmentStudents.map((student) => {
      const { password, ...studentWithoutPassword } = student;
      return studentWithoutPassword;
    });

    res.json({ success: true, students: studentsWithoutPasswords });
  } catch (error) {
    res.json({
      success: false,
      message: "Error fetching students: " + error.message,
    });
  }
});

// Teacher Management
app.get("/api/teachers/:department", async (req, res) => {
  try {
    const departmentTeachers = await db
      .collection("users")
      .find({
        type: "teacher",
        department: req.params.department,
      })
      .toArray();

    // Remove passwords from response
    const teachersWithoutPasswords = departmentTeachers.map((teacher) => {
      const { password, ...teacherWithoutPassword } = teacher;
      return teacherWithoutPassword;
    });

    res.json({ success: true, teachers: teachersWithoutPasswords });
  } catch (error) {
    res.json({
      success: false,
      message: "Error fetching teachers: " + error.message,
    });
  }
});

// Notification Management
app.get("/api/notifications/:userEmail", async (req, res) => {
  try {
    const userNotifications = await db
      .collection("notifications")
      .find({
        userEmail: req.params.userEmail,
      })
      .sort({ timestamp: -1 })
      .toArray();

    res.json({ success: true, notifications: userNotifications });
  } catch (error) {
    res.json({
      success: false,
      message: "Error fetching notifications: " + error.message,
    });
  }
});

app.post("/api/notifications/mark-read", async (req, res) => {
  try {
    const { notificationId } = req.body;

    await db
      .collection("notifications")
      .updateOne({ id: notificationId }, { $set: { read: true } });

    res.json({ success: true, message: "Notification marked as read" });
  } catch (error) {
    res.json({
      success: false,
      message: "Error marking notification as read: " + error.message,
    });
  }
});

// Timetable Management
app.post(
  "/api/timetable",
  upload.single("timetableImage"),
  async (req, res) => {
    try {
      const { teacherEmail, department, description } = req.body;

      const timetable = {
        id: uuidv4(),
        teacherEmail,
        department,
        description,
        image: req.file ? `/uploads/${req.file.filename}` : null,
        uploadedDate: new Date().toISOString(),
      };

      await db.collection("timetables").insertOne(timetable);

      // Notify students in the department
      const departmentStudents = await db
        .collection("users")
        .find({
          type: "student",
          department: department,
        })
        .toArray();

      departmentStudents.forEach((student) => {
        sendNotification(
          student.email,
          "New Timetable Available",
          `A new timetable has been uploaded for your department.`,
          "info"
        );
      });

      res.json({ success: true, message: "Timetable uploaded successfully" });
    } catch (error) {
      res.json({
        success: false,
        message: "Timetable upload failed: " + error.message,
      });
    }
  }
);

app.get("/api/timetable/:department", async (req, res) => {
  try {
    const departmentTimetable = await db
      .collection("timetables")
      .find({
        department: req.params.department,
      })
      .sort({ uploadedDate: -1 })
      .limit(1)
      .toArray();

    res.json({ success: true, timetable: departmentTimetable[0] || null });
  } catch (error) {
    res.json({
      success: false,
      message: "Error fetching timetable: " + error.message,
    });
  }
});

// AI Chatbot
app.post("/api/chatbot", (req, res) => {
  try {
    const { message, userType, context } = req.body;
    const lowerMessage = message.toLowerCase();

    let response = chatbotResponses.default;

    for (const [key, value] of Object.entries(chatbotResponses)) {
      if (lowerMessage.includes(key) && key !== "default") {
        response = value;
        break;
      }
    }

    // Add user-specific context
    if (userType === "student") {
      response +=
        " As a student, you can access these features through your dashboard.";
    } else if (userType === "teacher") {
      response +=
        " As a teacher, you can manage these features through your dashboard.";
    } else if (userType === "parent") {
      response +=
        " As a parent, you can monitor your child's progress through these features.";
    }

    res.json({ success: true, response });
  } catch (error) {
    res.json({ success: false, message: "Chatbot error: " + error.message });
  }
});

// Previous Papers Management
app.post(
  "/api/previous-papers",
  upload.single("paperFile"),
  async (req, res) => {
    try {
      const { teacherEmail, title, subject, semester, year } = req.body;

      const paper = {
        id: uuidv4(),
        teacherEmail,
        title,
        subject,
        semester,
        year,
        file: req.file
          ? {
              name: req.file.originalname,
              url: `/uploads/${req.file.filename}`,
              uploadedDate: new Date().toISOString(),
            }
          : null,
        uploadedDate: new Date().toISOString(),
      };

      await db.collection("previousPapers").insertOne(paper);

      // Notify students in the same department
      const teacher = await db
        .collection("users")
        .findOne({ email: teacherEmail });
      if (teacher) {
        const departmentStudents = await db
          .collection("users")
          .find({
            type: "student",
            department: teacher.department,
          })
          .toArray();

        departmentStudents.forEach((student) => {
          sendNotification(
            student.email,
            "New Previous Paper Available",
            `A new previous paper "${title}" has been uploaded for ${subject}.`,
            "info"
          );
        });
      }

      res.json({ success: true, message: "Paper uploaded successfully" });
    } catch (error) {
      res.json({
        success: false,
        message: "Paper upload failed: " + error.message,
      });
    }
  }
);

app.get("/api/previous-papers", async (req, res) => {
  try {
    const papers = await db.collection("previousPapers").find({}).toArray();
    res.json({ success: true, papers: papers });
  } catch (error) {
    res.json({
      success: false,
      message: "Error fetching previous papers: " + error.message,
    });
  }
});

// Monthly Leaderboard Management
app.post("/api/leaderboard", async (req, res) => {
  try {
    const { teacherEmail, month, year, topStudents } = req.body;

    // Check if leaderboard already exists for this month
    const existingLeaderboard = await db.collection("leaderboard").findOne({
      month,
      year,
    });

    if (existingLeaderboard) {
      return res.json({
        success: false,
        message: "Leaderboard already exists for this month",
      });
    }

    const leaderboard = {
      id: uuidv4(),
      teacherEmail,
      month,
      year,
      topStudents: topStudents.map((student, index) => ({
        ...student,
        position: index + 1,
        credits: 100 - index * 20, // 100 for 1st, 80 for 2nd, 60 for 3rd
      })),
      createdDate: new Date().toISOString(),
    };

    await db.collection("leaderboard").insertOne(leaderboard);

    // Update student credits and send notifications
    for (const student of leaderboard.topStudents) {
      await db
        .collection("users")
        .updateOne(
          { email: student.email },
          { $inc: { performanceCredits: student.credits } }
        );

      sendNotification(
        student.email,
        "🏆 Leaderboard Achievement!",
        `Congratulations! You ranked #${student.position} in the ${month} ${year} leaderboard and earned ${student.credits} performance credits!`,
        "success"
      );
    }

    // Notify all students about new leaderboard
    const teacher = await db
      .collection("users")
      .findOne({ email: teacherEmail });
    if (teacher) {
      const departmentStudents = await db
        .collection("users")
        .find({
          type: "student",
          department: teacher.department,
        })
        .toArray();

      departmentStudents.forEach((student) => {
        if (!topStudents.find((s) => s.email === student.email)) {
          sendNotification(
            student.email,
            "New Leaderboard Published",
            `The ${month} ${year} leaderboard has been published. Check it out in your dashboard!`,
            "info"
          );
        }
      });
    }

    res.json({ success: true, message: "Leaderboard published successfully" });
  } catch (error) {
    res.json({
      success: false,
      message: "Leaderboard publication failed: " + error.message,
    });
  }
});

app.get("/api/leaderboard/current", async (req, res) => {
  try {
    const currentDate = new Date();
    const currentMonth = currentDate.toLocaleString("default", {
      month: "long",
    });
    const currentYear = currentDate.getFullYear();

    const leaderboard = await db.collection("leaderboard").findOne({
      month: currentMonth,
      year: currentYear,
    });

    res.json({ success: true, leaderboard: leaderboard });
  } catch (error) {
    res.json({
      success: false,
      message: "Error fetching leaderboard: " + error.message,
    });
  }
});

app.get("/api/leaderboard/history", async (req, res) => {
  try {
    const leaderboards = await db
      .collection("leaderboard")
      .find({})
      .sort({ year: -1, month: -1 })
      .toArray();

    res.json({ success: true, leaderboards: leaderboards });
  } catch (error) {
    res.json({
      success: false,
      message: "Error fetching leaderboard history: " + error.message,
    });
  }
});

// Student Performance Credits
app.get("/api/student/credits/:studentEmail", async (req, res) => {
  try {
    const student = await db.collection("users").findOne({
      email: req.params.studentEmail,
      type: "student",
    });

    if (student) {
      res.json({ success: true, credits: student.performanceCredits || 0 });
    } else {
      res.json({ success: false, message: "Student not found" });
    }
  } catch (error) {
    res.json({
      success: false,
      message: "Error fetching student credits: " + error.message,
    });
  }
});

// Top Performing Students
app.get("/api/top-students/:department", async (req, res) => {
  try {
    const topStudents = await db
      .collection("users")
      .find({
        type: "student",
        department: req.params.department,
      })
      .sort({ performanceCredits: -1 })
      .limit(10)
      .toArray();

    // Remove passwords from response
    const studentsWithoutPasswords = topStudents.map((student) => {
      const { password, ...studentWithoutPassword } = student;
      return studentWithoutPassword;
    });

    res.json({ success: true, students: studentsWithoutPasswords });
  } catch (error) {
    res.json({
      success: false,
      message: "Error fetching top students: " + error.message,
    });
  }
});

// Semester Results Management
app.post("/api/semester-results", async (req, res) => {
  try {
    const { teacherEmail, course, semester, results } = req.body;

    const semesterResult = {
      id: uuidv4(),
      teacherEmail,
      course,
      semester,
      results,
      publishedDate: new Date().toISOString(),
    };

    await db.collection("semesterResults").insertOne(semesterResult);

    // Notify students
    results.forEach((result) => {
      sendNotification(
        result.studentEmail,
        "Semester Results Published",
        `The results for ${course} - ${semester} have been published. Check your results section.`,
        "info"
      );
    });

    res.json({
      success: true,
      message: "Semester results published successfully",
    });
  } catch (error) {
    res.json({
      success: false,
      message: "Semester results publication failed: " + error.message,
    });
  }
});

app.get("/api/semester-results/:studentEmail", async (req, res) => {
  try {
    const studentSemesterResults = await db
      .collection("semesterResults")
      .find({
        "results.studentEmail": req.params.studentEmail,
      })
      .toArray();

    res.json({ success: true, results: studentSemesterResults });
  } catch (error) {
    res.json({
      success: false,
      message: "Error fetching semester results: " + error.message,
    });
  }
});

// Performance Analytics
app.get("/api/performance/:studentEmail", async (req, res) => {
  try {
    const studentEmail = req.params.studentEmail;

    // Get attendance data
    const studentAttendance = await db
      .collection("attendance")
      .find({
        studentEmail: studentEmail,
      })
      .toArray();

    // Get grades data
    const studentGrades = await db
      .collection("grades")
      .find({
        studentEmail: studentEmail,
      })
      .toArray();

    // Calculate attendance percentage by course
    const courseAttendance = {};
    studentAttendance.forEach((record) => {
      if (!courseAttendance[record.course]) {
        courseAttendance[record.course] = { present: 0, total: 0 };
      }
      courseAttendance[record.course].total++;
      if (record.status === "present") {
        courseAttendance[record.course].present++;
      }
    });

    // Calculate percentages
    Object.keys(courseAttendance).forEach((course) => {
      const data = courseAttendance[course];
      data.percentage = (data.present / data.total) * 100;
    });

    res.json({
      success: true,
      attendance: courseAttendance,
      grades: studentGrades,
    });
  } catch (error) {
    res.json({
      success: false,
      message: "Error fetching performance data: " + error.message,
    });
  }
});

// Parent-specific routes
app.get("/api/parent-student/:parentEmail", async (req, res) => {
  try {
    const parent = await db.collection("users").findOne({
      email: req.params.parentEmail,
      type: "parent",
    });

    if (!parent) {
      return res.json({ success: false, message: "Parent not found" });
    }

    const student = await db.collection("users").findOne({
      email: parent.studentEmail,
      type: "student",
    });

    if (!student) {
      return res.json({ success: false, message: "Student not found" });
    }

    const { password, ...studentWithoutPassword } = student;
    res.json({ success: true, student: studentWithoutPassword });
  } catch (error) {
    res.json({
      success: false,
      message: "Error fetching student data: " + error.message,
    });
  }
});

// Teacher-Parent Chat Management
app.get("/api/chat-messages/:parentEmail/:teacherEmail", async (req, res) => {
  try {
    const messages = await db
      .collection("chatMessages")
      .find({
        $or: [
          {
            parentEmail: req.params.parentEmail,
            teacherEmail: req.params.teacherEmail,
          },
          {
            parentEmail: req.params.teacherEmail,
            teacherEmail: req.params.parentEmail,
          },
        ],
      })
      .sort({ timestamp: 1 })
      .toArray();

    res.json({ success: true, messages });
  } catch (error) {
    res.json({
      success: false,
      message: "Error fetching chat messages: " + error.message,
    });
  }
});

// Initialize with sample data
async function initializeSampleData() {
  const userCount = await db.collection("users").countDocuments();

  if (userCount === 0) {
    console.log("Initializing sample data...");

    // Sample students
    const sampleStudents = [
      {
        id: uuidv4(),
        type: "student",
        email: "student1@example.com",
        password: "password123",
        name: "John Doe",
        department: "computer_science",
        rollNumber: "CS001",
        fatherName: "Robert Doe",
        performanceCredits: 150,
        registrationDate: new Date().toISOString(),
      },
      {
        id: uuidv4(),
        type: "student",
        email: "student2@example.com",
        password: "password123",
        name: "Jane Smith",
        department: "computer_science",
        rollNumber: "CS002",
        fatherName: "Michael Smith",
        performanceCredits: 120,
        registrationDate: new Date().toISOString(),
      },
      {
        id: uuidv4(),
        type: "student",
        email: "student3@example.com",
        password: "password123",
        name: "Mike Johnson",
        department: "computer_science",
        rollNumber: "CS003",
        fatherName: "David Johnson",
        performanceCredits: 90,
        registrationDate: new Date().toISOString(),
      },
    ];

    await db.collection("users").insertMany(sampleStudents);

    // Sample teacher
    await db.collection("users").insertOne({
      id: uuidv4(),
      type: "teacher",
      email: "teacher@example.com",
      password: "password123",
      name: "Dr. Sarah Johnson",
      department: "computer_science",
      subject: "Programming",
      registrationDate: new Date().toISOString(),
    });

    // Sample parent accounts
    const sampleParents = [
      {
        id: uuidv4(),
        type: "parent",
        email: "parent1@example.com",
        password: "password123",
        name: "Robert Doe (Parent)",
        studentEmail: "student1@example.com",
        registrationDate: new Date().toISOString(),
      },
      {
        id: uuidv4(),
        type: "parent",
        email: "parent2@example.com",
        password: "password123",
        name: "Michael Smith (Parent)",
        studentEmail: "student2@example.com",
        registrationDate: new Date().toISOString(),
      },
      {
        id: uuidv4(),
        type: "parent",
        email: "parent3@example.com",
        password: "password123",
        name: "David Johnson (Parent)",
        studentEmail: "student3@example.com",
        registrationDate: new Date().toISOString(),
      },
    ];

    await db.collection("users").insertMany(sampleParents);

    // Sample courses
    const sampleCourses = [
      {
        id: uuidv4(),
        teacherEmail: "teacher@example.com",
        courseName: "Introduction to Programming",
        description: "Learn the fundamentals of programming with Python",
        department: "computer_science",
        duration: "1 semester",
        files: [],
        createdDate: new Date().toISOString(),
      },
      {
        id: uuidv4(),
        teacherEmail: "teacher@example.com",
        courseName: "Data Structures",
        description: "Learn about arrays, linked lists, trees, and algorithms",
        department: "computer_science",
        duration: "1 semester",
        files: [],
        createdDate: new Date().toISOString(),
      },
    ];

    await db.collection("courses").insertMany(sampleCourses);

    // Sample enrollments
    const courses = await db.collection("courses").find({}).toArray();
    const sampleEnrollments = [
      {
        id: uuidv4(),
        studentEmail: "student1@example.com",
        courseId: courses[0].id,
        enrolledDate: new Date().toISOString(),
      },
      {
        id: uuidv4(),
        studentEmail: "student2@example.com",
        courseId: courses[0].id,
        enrolledDate: new Date().toISOString(),
      },
      {
        id: uuidv4(),
        studentEmail: "student3@example.com",
        courseId: courses[0].id,
        enrolledDate: new Date().toISOString(),
      },
      {
        id: uuidv4(),
        studentEmail: "student1@example.com",
        courseId: courses[1].id,
        enrolledDate: new Date().toISOString(),
      },
    ];

    await db.collection("enrollments").insertMany(sampleEnrollments);

    // Sample assignments
    await db.collection("assignments").insertOne({
      id: uuidv4(),
      teacherEmail: "teacher@example.com",
      title: "Python Basics Assignment",
      description: "Complete the exercises on variables, loops, and functions",
      dueDate: "2024-12-15",
      course: "Introduction to Programming",
      department: "computer_science",
      files: [],
      createdDate: new Date().toISOString(),
    });

    // Sample attendance records
    const today = new Date().toISOString().split("T")[0];
    const yesterday = new Date(Date.now() - 86400000)
      .toISOString()
      .split("T")[0];

    const sampleAttendance = [
      {
        id: uuidv4(),
        teacherEmail: "teacher@example.com",
        studentEmail: "student1@example.com",
        course: "Introduction to Programming",
        date: today,
        status: "present",
        recordedDate: new Date().toISOString(),
      },
      {
        id: uuidv4(),
        teacherEmail: "teacher@example.com",
        studentEmail: "student2@example.com",
        course: "Introduction to Programming",
        date: today,
        status: "present",
        recordedDate: new Date().toISOString(),
      },
      {
        id: uuidv4(),
        teacherEmail: "teacher@example.com",
        studentEmail: "student3@example.com",
        course: "Introduction to Programming",
        date: today,
        status: "absent",
        recordedDate: new Date().toISOString(),
      },
      {
        id: uuidv4(),
        teacherEmail: "teacher@example.com",
        studentEmail: "student1@example.com",
        course: "Introduction to Programming",
        date: yesterday,
        status: "present",
        recordedDate: new Date().toISOString(),
      },
      {
        id: uuidv4(),
        teacherEmail: "teacher@example.com",
        studentEmail: "student2@example.com",
        course: "Introduction to Programming",
        date: yesterday,
        status: "absent",
        recordedDate: new Date().toISOString(),
      },
    ];

    await db.collection("attendance").insertMany(sampleAttendance);

    // Sample grades
    const assignments = await db.collection("assignments").find({}).toArray();
    const sampleGrades = [
      {
        id: uuidv4(),
        teacherEmail: "teacher@example.com",
        studentEmail: "student1@example.com",
        course: "Introduction to Programming",
        grade: "A",
        semester: "2024-1",
        assignmentId: assignments[0].id,
        uploadedDate: new Date().toISOString(),
      },
      {
        id: uuidv4(),
        teacherEmail: "teacher@example.com",
        studentEmail: "student2@example.com",
        course: "Introduction to Programming",
        grade: "B+",
        semester: "2024-1",
        assignmentId: assignments[0].id,
        uploadedDate: new Date().toISOString(),
      },
      {
        id: uuidv4(),
        teacherEmail: "teacher@example.com",
        studentEmail: "student3@example.com",
        course: "Introduction to Programming",
        grade: "B",
        semester: "2024-1",
        assignmentId: assignments[0].id,
        uploadedDate: new Date().toISOString(),
      },
    ];

    await db.collection("grades").insertMany(sampleGrades);

    // Sample timetable
    await db.collection("timetables").insertOne({
      id: uuidv4(),
      teacherEmail: "teacher@example.com",
      department: "computer_science",
      description: "Fall 2024 Timetable",
      image: null,
      uploadedDate: new Date().toISOString(),
    });

    // Sample previous papers
    await db.collection("previousPapers").insertOne({
      id: uuidv4(),
      teacherEmail: "teacher@example.com",
      title: "Programming Fundamentals - 2023",
      subject: "programming",
      semester: "Semester 1",
      year: "2023",
      file: {
        name: "programming_fundamentals_2023.pdf",
        url: "/uploads/sample_paper.pdf",
        uploadedDate: new Date().toISOString(),
      },
      uploadedDate: new Date().toISOString(),
    });

    // Sample leaderboard
    const currentDate = new Date();
    const currentMonth = currentDate.toLocaleString("default", {
      month: "long",
    });
    const currentYear = currentDate.getFullYear();

    await db.collection("leaderboard").insertOne({
      id: uuidv4(),
      teacherEmail: "teacher@example.com",
      month: currentMonth,
      year: currentYear,
      topStudents: [
        {
          email: "student1@example.com",
          name: "John Doe",
          position: 1,
          credits: 100,
        },
        {
          email: "student2@example.com",
          name: "Jane Smith",
          position: 2,
          credits: 80,
        },
        {
          email: "student3@example.com",
          name: "Mike Johnson",
          position: 3,
          credits: 60,
        },
      ],
      createdDate: new Date().toISOString(),
    });

    console.log("Sample data initialized successfully");
    console.log("Student 1: student1@example.com / password123");
    console.log("Student 2: student2@example.com / password123");
    console.log("Student 3: student3@example.com / password123");
    console.log("Teacher: teacher@example.com / password123");
    console.log("Parent 1: parent1@example.com / password123");
    console.log("Parent 2: parent2@example.com / password123");
    console.log("Parent 3: parent3@example.com / password123");
  }
}

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, message: "Endpoint not found" });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error("Error:", error);
  res.status(500).json({ success: false, message: "Internal server error" });
});

// Start server
connectDB()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Access the application at: http://localhost:${PORT}`);
      initializeSampleData();
    });
  })
  .catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
  });
